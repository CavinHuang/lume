import type {
  AgentAskUserQuestionQuestion,
  AgentAskUserQuestionRequest,
  AgentAskUserQuestionResponseInput
} from "@lume/shared";
import {
  type PersistedAskUserInterruptionResolution,
  persistAskUserInterruption,
  resolvePersistedAskUserInterruption,
  resolveAskUserInterruption,
  updateAskUserApprovalSession
} from "./ask-user-service";
import { listPendingRuntimeCoreInterruptions } from "./interruption-pending";
import { PendingRequestRegistry } from "./pending-request-registry";
import { createLogger } from "../../infra/logger";

const log = createLogger("ask-user-question-session");

interface AskUserPendingMeta {
  threadId: string;
  approvalSessionId: string;
  request: AgentAskUserQuestionRequest;
}

// #580:Map+timeout+resolve 手写三联收编进 PendingRequestRegistry。
const pendingAskUserQuestionResolvers =
  new PendingRequestRegistry<string, AskUserQuestionWaitResult, AskUserPendingMeta>();

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface AskUserQuestionWaitResult {
  status: "answered" | "canceled" | "aborted" | "timeout";
  answers: Record<string, string> | null;
}

export type AskUserQuestionSubmitResult =
  | {
      handledBy: "live";
      threadId: string;
      approvalThreadId: string;
      runId?: string;
    }
  | PersistedAskUserInterruptionResolution;

export function setAskUserQuestionApprovalSession(toolUseId: string, approvalSessionId: string): void {
  const meta = pendingAskUserQuestionResolvers.getMeta(toolUseId);
  if (!meta) return;
  const normalized = approvalSessionId.trim();
  if (!normalized) return;
  pendingAskUserQuestionResolvers.updateMeta(toolUseId, { approvalSessionId: normalized });
  void updateAskUserApprovalSession({
    originalThreadId: meta.threadId,
    approvalThreadId: normalized,
    request: meta.request
  }).catch((error) => {
    log.warn("Failed to update ask-user approval session", {
      toolUseId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function resolveAskTimeoutMs(): number {
  const raw = process.env.LUME_ASK_USER_QUESTION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ASK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_ASK_TIMEOUT_MS;
  const minTimeoutMs = process.env.LUME_ASK_USER_QUESTION_ALLOW_LOW_TIMEOUT === "1" ? 10 : 30_000;
  return Math.max(minTimeoutMs, Math.min(60 * 60 * 1000, Math.floor(parsed)));
}

export function waitForAskUserQuestionAnswers(
  threadId: string,
  toolUseId: string,
  questions: AgentAskUserQuestionQuestion[],
  signal: AbortSignal,
  emit: (request: AgentAskUserQuestionRequest) => void,
  requestMeta?: Pick<AgentAskUserQuestionRequest, "runId" | "originThreadId" | "subagentRunId" | "subagentLabel">
): Promise<AskUserQuestionWaitResult> {
  const timeoutMs = resolveAskTimeoutMs();
  const request: AgentAskUserQuestionRequest = {
    threadId,
    ...(requestMeta?.runId ? { runId: requestMeta.runId } : {}),
    ...(requestMeta?.originThreadId ? { originThreadId: requestMeta.originThreadId } : {}),
    ...(requestMeta?.subagentRunId ? { subagentRunId: requestMeta.subagentRunId } : {}),
    ...(requestMeta?.subagentLabel ? { subagentLabel: requestMeta.subagentLabel } : {}),
    toolUseId,
    questions
  };
  // 二轮复审 P2-3:死信号场景不得发提问卡、不得持久化——否则 registry 短路
  // resolve 的持久化清理读不到尚未落盘的 pending 记录,runContinuation 残留
  // waiting_for_interruption(desktop 收到死提问卡)。
  if (signal.aborted) {
    const abortedResult: AskUserQuestionWaitResult = { status: "aborted", answers: null };
    return Promise.resolve(abortedResult);
  }
  const promise = pendingAskUserQuestionResolvers.wait(toolUseId, {
    meta: { threadId, approvalSessionId: threadId, request },
    timeoutMs,
    signal,
    timeoutValue: () => ({ status: "timeout", answers: null }),
    abortValue: () => ({ status: "aborted", answers: null }),
    supersededValue: () => ({ status: "canceled", answers: null }),
    // Bun test 环境下超短 unref timer 可能不会按预期触发，测试专用短超时不做 unref。
    unref: timeoutMs >= 1000,
    beforeResolve: async (result) => {
      try {
        await resolveAskUserInterruption({
          threadId,
          toolUseId,
          canceled: result.status !== "answered",
          answers: result.answers ?? undefined
        });
      } catch (error) {
        // 持久化失败只降级冷启动恢复能力;resolve 必须仍被执行(Registry 保证)
        log.warn("Failed to resolve ask-user interruption", {
          toolUseId,
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
  void persistAskUserInterruption(request).catch((error) => {
    log.warn("Failed to persist ask-user interruption", {
      toolUseId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  emit(request);
  return promise;
}

export async function submitAskUserQuestionAnswers(
  input: AgentAskUserQuestionResponseInput
): Promise<AskUserQuestionSubmitResult | null> {
  const meta = pendingAskUserQuestionResolvers.getMeta(input.toolUseId);
  if (!meta) {
    return await resolvePersistedAskUserInterruption({
      approvalThreadId: input.threadId,
      toolUseId: input.toolUseId,
      canceled: input.canceled,
      answers: input.answers
    });
  }
  if (meta.approvalSessionId !== input.threadId) {
    throw new Error("AskUserQuestion 会话不匹配");
  }
  const waitResult: AskUserQuestionWaitResult = input.canceled
    ? { status: "canceled", answers: null }
    : { status: "answered", answers: input.answers ?? {} };
  pendingAskUserQuestionResolvers.settle(input.toolUseId, waitResult);
  return {
    handledBy: "live",
    threadId: meta.threadId,
    approvalThreadId: input.threadId,
    ...(meta.request.runId ? { runId: meta.request.runId } : {})
  };
}

export function cancelPendingAskUserQuestionBySession(threadId: string): void {
  pendingAskUserQuestionResolvers.cancelWhere(
    (meta) => meta.threadId === threadId || meta.approvalSessionId === threadId,
    () => ({ status: "canceled", answers: null })
  );
}

export function listPendingAskUserQuestionRequests(): AgentAskUserQuestionRequest[] {
  const liveRequests = pendingAskUserQuestionResolvers.list().map(({ meta }) => ({
    ...meta.request,
    threadId: meta.approvalSessionId,
    ...(meta.request.originThreadId ? {} : (
      meta.threadId !== meta.approvalSessionId
        ? { originThreadId: meta.threadId }
        : {}
    ))
  }));
  mergePersistedAskUserRequests(liveRequests);
  return liveRequests;
}

function mergePersistedAskUserRequests(target: AgentAskUserQuestionRequest[]): void {
  const seen = new Set(target.map((request) => request.toolUseId));
  const persisted = listPendingRuntimeCoreInterruptions();
  for (const interruption of persisted) {
    if (interruption.type !== "ask_user") continue;
    const payload = interruption.payload as AgentAskUserQuestionRequest;
    if (!payload?.toolUseId || seen.has(payload.toolUseId)) continue;
    seen.add(payload.toolUseId);
    target.push(payload);
  }
}
