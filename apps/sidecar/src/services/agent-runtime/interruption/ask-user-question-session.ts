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
import { listPendingRuntimeCoreInterruptions } from "./interruption-index";

const pendingAskUserQuestionResolvers = new Map<
  string,
  {
    threadId: string;
    approvalSessionId: string;
    request: AgentAskUserQuestionRequest;
    resolve: (result: AskUserQuestionWaitResult) => void;
    timeout?: ReturnType<typeof setTimeout>;
  }
>();

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
  const pending = pendingAskUserQuestionResolvers.get(toolUseId);
  if (!pending) return;
  const normalized = approvalSessionId.trim();
  if (!normalized) return;
  pending.approvalSessionId = normalized;
  void updateAskUserApprovalSession({
    originalThreadId: pending.threadId,
    approvalThreadId: normalized,
    request: pending.request
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
  return new Promise((resolve) => {
    const done = async (result: AskUserQuestionWaitResult): Promise<void> => {
      const pending = pendingAskUserQuestionResolvers.get(toolUseId);
      if (pending?.timeout) {
        clearTimeout(pending.timeout);
      }
      pendingAskUserQuestionResolvers.delete(toolUseId);
      signal.removeEventListener("abort", onAbort);
      await resolveAskUserInterruption({
        threadId,
        toolUseId,
        canceled: result.status !== "answered",
        answers: result.answers ?? undefined
      });
      resolve(result);
    };

    const onAbort = (): void => {
      done({ status: "aborted", answers: null });
    };

    const existing = pendingAskUserQuestionResolvers.get(toolUseId);
    if (existing) {
      existing.resolve({ status: "canceled", answers: null });
    }
    const timeoutMs = resolveAskTimeoutMs();
    const timeout = setTimeout(() => {
      done({ status: "timeout", answers: null });
    }, timeoutMs);
    // Bun test 环境下超短 unref timer 可能不会按预期触发，测试专用短超时不做 unref。
    if (
      timeoutMs >= 1000
      && typeof timeout === "object"
      && "unref" in timeout
      && typeof timeout.unref === "function"
    ) {
      timeout.unref();
    }
    const request: AgentAskUserQuestionRequest = {
      threadId,
      ...(requestMeta?.runId ? { runId: requestMeta.runId } : {}),
      ...(requestMeta?.originThreadId ? { originThreadId: requestMeta.originThreadId } : {}),
      ...(requestMeta?.subagentRunId ? { subagentRunId: requestMeta.subagentRunId } : {}),
      ...(requestMeta?.subagentLabel ? { subagentLabel: requestMeta.subagentLabel } : {}),
      toolUseId,
      questions
    };
    pendingAskUserQuestionResolvers.set(toolUseId, {
      threadId,
      approvalSessionId: threadId,
      request,
      resolve: done,
      timeout
    });
    signal.addEventListener("abort", onAbort, { once: true });
    void persistAskUserInterruption(request);
    emit(request);
  });
}

export async function submitAskUserQuestionAnswers(
  input: AgentAskUserQuestionResponseInput
): Promise<AskUserQuestionSubmitResult | null> {
  const pending = pendingAskUserQuestionResolvers.get(input.toolUseId);
  if (!pending) {
    return await resolvePersistedAskUserInterruption({
      approvalThreadId: input.threadId,
      toolUseId: input.toolUseId,
      canceled: input.canceled,
      answers: input.answers
    });
  }
  if (pending.approvalSessionId !== input.threadId) {
    throw new Error("AskUserQuestion 会话不匹配");
  }
  if (input.canceled) {
    pending.resolve({ status: "canceled", answers: null });
    return {
      handledBy: "live",
      threadId: pending.threadId,
      approvalThreadId: input.threadId,
      ...(pending.request.runId ? { runId: pending.request.runId } : {})
    };
  }
  pending.resolve({ status: "answered", answers: input.answers ?? {} });
  return {
    handledBy: "live",
    threadId: pending.threadId,
    approvalThreadId: input.threadId,
    ...(pending.request.runId ? { runId: pending.request.runId } : {})
  };
}

export function cancelPendingAskUserQuestionBySession(threadId: string): void {
  for (const [toolUseId, pending] of pendingAskUserQuestionResolvers) {
    if (pending.threadId !== threadId && pending.approvalSessionId !== threadId) {
      continue;
    }
    void resolveAskUserInterruption({
      threadId: pending.threadId,
      toolUseId,
      canceled: true
    });
    pending.resolve({ status: "canceled", answers: null });
    pendingAskUserQuestionResolvers.delete(toolUseId);
  }
}

export function listPendingAskUserQuestionRequests(): AgentAskUserQuestionRequest[] {
  const liveRequests = Array.from(pendingAskUserQuestionResolvers.values()).map((pending) => ({
    ...pending.request,
    threadId: pending.approvalSessionId,
    ...(pending.request.originThreadId ? {} : (
      pending.threadId !== pending.approvalSessionId
        ? { originThreadId: pending.threadId }
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
