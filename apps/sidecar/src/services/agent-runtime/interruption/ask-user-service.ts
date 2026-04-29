import type {
  AgentAskUserQuestionQuestion,
  AgentAskUserQuestionRequest
} from "@lume/shared";
import { getRuntimeCoreSessionDir } from "../../pi-agent/runtime-core/session-store";
import type { LumeInterruption } from "./interruption";
import { listPendingRuntimeCoreInterruptionRecords } from "./interruption-index";
import {
  createFileBackedLumeInterruptionStore,
  resolveFileBackedInterruptionSync
} from "./interruption-store";

export function askUserInterruptionId(toolUseId: string): string {
  return `ask_user:${toolUseId}`;
}

export async function persistAskUserInterruption(request: AgentAskUserQuestionRequest): Promise<LumeInterruption> {
  const now = new Date().toISOString();
  const interruption: LumeInterruption = {
    id: askUserInterruptionId(request.toolUseId),
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
  await createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(request.threadId)).upsert(interruption);
  return interruption;
}

export async function resolveAskUserInterruption(input: {
  threadId: string;
  toolUseId: string;
  canceled?: boolean;
  answers?: Record<string, string>;
}): Promise<void> {
  await createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(input.threadId)).resolve(
    askUserInterruptionId(input.toolUseId),
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

export function resolvePersistedAskUserInterruption(input: {
  approvalThreadId: string;
  toolUseId: string;
  canceled?: boolean;
  answers?: Record<string, string>;
}): boolean {
  const matched = listPendingRuntimeCoreInterruptionRecords().find((record) => {
    const payload = record.interruption.payload as AgentAskUserQuestionRequest;
    return record.interruption.type === "ask_user"
      && payload?.toolUseId === input.toolUseId
      && record.interruption.threadId === input.approvalThreadId;
  });
  if (!matched) return false;
  return resolveFileBackedInterruptionSync(
    matched.sessionDir,
    askUserInterruptionId(input.toolUseId),
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
}

function summarizeQuestions(questions: AgentAskUserQuestionQuestion[]): string {
  return questions.map((item) => item.question).filter(Boolean).join("\n") || "Agent 请求用户输入";
}
