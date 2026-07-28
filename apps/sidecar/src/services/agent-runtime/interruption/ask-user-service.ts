import type {
  AgentAskUserQuestionQuestion,
  AgentAskUserQuestionRequest
} from "@lume/shared";
import { createHash } from "node:crypto";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import type { LumeInterruption } from "./interruption";
import { listPendingRuntimeCoreInterruptionRecords } from "./interruption-index";
import {
  createFileBackedLumeInterruptionStore,
  resolveFileBackedInterruptionSync
} from "./interruption-store";
import { createFileBackedRunContinuationStore } from "../runner/run-continuation-store";

export interface PersistedAskUserInterruptionResolution {
  handledBy: "persisted";
  threadId: string;
  approvalThreadId: string;
  runId?: string;
}

export function askUserInterruptionId(toolUseId: string): string {
  return `ask_user:${toolUseId}`;
}

export async function persistAskUserInterruption(request: AgentAskUserQuestionRequest): Promise<LumeInterruption> {
  const now = new Date().toISOString();
  const interruption: LumeInterruption = {
    id: askUserInterruptionId(request.toolUseId),
    runId: request.runId,
    threadId: request.threadId,
    originThreadId: request.originThreadId,
    type: "ask_user",
    status: "pending",
    title: "需要用户回答",
    message: summarizeQuestions(request.questions),
    payload: request,
    source: {
      toolCallId: request.toolUseId,
      subagentRunId: request.subagentRunId,
      subagentLabel: request.subagentLabel
    },
    createdAt: now,
    updatedAt: now
  };
  const sessionDir = getRuntimeCoreSessionDir(request.threadId);
  await createFileBackedLumeInterruptionStore(sessionDir).upsert(interruption);
  if (request.runId) {
    await createFileBackedRunContinuationStore(sessionDir).upsert({
      version: 2,
      runId: request.runId,
      threadId: request.threadId,
      status: "waiting_for_interruption",
      checkpoint: {
        step: "waiting_for_tool_result",
        interruptionId: interruption.id,
        toolCallId: request.toolUseId,
        toolName: "AskUserQuestion",
        toolKind: "control",
        toolCall: {
          id: request.toolUseId,
          name: "AskUserQuestion",
          input: { questions: request.questions },
          inputHash: hashAskUserInput(request.questions),
          kind: "control"
        }
      },
      reason: "等待 AskUserQuestion 用户回答。",
      createdAt: now,
      updatedAt: now
    });
  }
  return interruption;
}

function hashAskUserInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

export async function resolveAskUserInterruption(input: {
  threadId: string;
  toolUseId: string;
  canceled?: boolean;
  answers?: Record<string, string>;
}): Promise<void> {
  const sessionDir = getRuntimeCoreSessionDir(input.threadId);
  const interruptionId = askUserInterruptionId(input.toolUseId);
  const store = createFileBackedLumeInterruptionStore(sessionDir);
  const current = await store.get(interruptionId);
  await store.resolve(
    interruptionId,
    {
      status: input.canceled ? "rejected" : "approved",
      resolution: input.canceled
        ? { decision: "reject" }
        : {
            decision: "answer",
            answer: input.answers ?? {}
          }
    }
  );
  if (current?.runId) {
    await createFileBackedRunContinuationStore(sessionDir).update(current.runId, {
      status: "ready_to_resume",
      checkpoint: {
        step: "after_tool_result",
        interruptionId,
        toolCallId: input.toolUseId,
        toolName: "AskUserQuestion",
        toolKind: "control",
        syntheticToolResult: input.canceled
          ? { status: "canceled", answers: null }
          : { status: "answered", answers: input.answers ?? {} }
      },
      reason: input.canceled
        ? "AskUserQuestion 已取消，恢复时将注入取消结果。"
        : "AskUserQuestion 已回答，恢复时将注入答案。"
    });
  }
}

export async function updateAskUserApprovalSession(input: {
  originalThreadId: string;
  approvalThreadId: string;
  request: AgentAskUserQuestionRequest;
}): Promise<void> {
  const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(input.originalThreadId));
  const current = await store.get(askUserInterruptionId(input.request.toolUseId));
  if (!current) return;
  const updatedRequest: AgentAskUserQuestionRequest = {
    ...input.request,
    threadId: input.approvalThreadId,
    originThreadId: input.request.originThreadId ?? input.originalThreadId
  };
  await store.upsert({
    ...current,
    threadId: input.approvalThreadId,
    originThreadId: updatedRequest.originThreadId,
    payload: updatedRequest,
    updatedAt: new Date().toISOString()
  });
}

export async function resolvePersistedAskUserInterruption(input: {
  approvalThreadId: string;
  toolUseId: string;
  canceled?: boolean;
  answers?: Record<string, string>;
}): Promise<PersistedAskUserInterruptionResolution | null> {
  const matched = listPendingRuntimeCoreInterruptionRecords().find((record) => {
    const payload = record.interruption.payload as AgentAskUserQuestionRequest;
    return record.interruption.type === "ask_user"
      && payload?.toolUseId === input.toolUseId
      && record.interruption.threadId === input.approvalThreadId;
  });
  if (!matched) return null;
  const interruptionId = askUserInterruptionId(input.toolUseId);
  const resolved = resolveFileBackedInterruptionSync(
    matched.sessionDir,
    interruptionId,
    {
      status: input.canceled ? "rejected" : "approved",
      resolution: input.canceled
        ? { decision: "reject" }
        : {
            decision: "answer",
            answer: input.answers ?? {}
        }
    }
  );
  if (resolved && matched.interruption.runId) {
    await createFileBackedRunContinuationStore(matched.sessionDir).update(matched.interruption.runId, {
      status: "ready_to_resume",
      checkpoint: {
        step: "after_tool_result",
        interruptionId,
        toolCallId: input.toolUseId,
        toolName: "AskUserQuestion",
        toolKind: "control",
        syntheticToolResult: input.canceled
          ? { status: "canceled", answers: null }
          : { status: "answered", answers: input.answers ?? {} }
      },
      reason: input.canceled
        ? "AskUserQuestion 已取消，恢复时将注入取消结果。"
        : "AskUserQuestion 已回答，恢复时将注入答案。"
    });
  }
  if (!resolved) return null;
  const payload = matched.interruption.payload as AgentAskUserQuestionRequest;
  return {
    handledBy: "persisted",
    threadId: matched.interruption.originThreadId ?? payload.originThreadId ?? matched.interruption.threadId,
    approvalThreadId: input.approvalThreadId,
    ...(matched.interruption.runId ? { runId: matched.interruption.runId } : {})
  };
}

function summarizeQuestions(questions: AgentAskUserQuestionQuestion[]): string {
  return questions.map((item) => item.question).filter(Boolean).join("\n") || "Agent 请求用户输入";
}
