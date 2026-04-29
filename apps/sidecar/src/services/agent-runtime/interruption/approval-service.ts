import type {
  AgentToolPermissionDecision,
  AgentToolPermissionRequest
} from "@lume/shared";
import { getRuntimeCoreSessionDir } from "../../pi-agent/runtime-core/session-store";
import type { LumeInterruption } from "./interruption";
import { listPendingRuntimeCoreInterruptionRecords } from "./interruption-index";
import {
  createFileBackedLumeInterruptionStore,
  resolveFileBackedInterruptionSync
} from "./interruption-store";

export function toolApprovalInterruptionId(requestId: string): string {
  return `tool_approval:${requestId}`;
}

export async function persistToolApprovalInterruption(request: AgentToolPermissionRequest): Promise<LumeInterruption> {
  const now = new Date().toISOString();
  const type = request.interruptionType ?? "tool_approval";
  const interruption: LumeInterruption = {
    id: toolApprovalInterruptionId(request.requestId),
    threadId: request.threadId,
    originThreadId: request.originThreadId,
    type,
    status: "pending",
    title: type === "automation_approval"
      ? `确认自动化执行 ${request.toolName}`
      : `确认执行 ${request.toolName}`,
    message: request.reason,
    payload: request,
    source: {
      toolName: request.toolName,
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

export async function resolveToolApprovalInterruption(input: {
  threadId: string;
  requestId: string;
  decision: AgentToolPermissionDecision | null;
}): Promise<void> {
  const approved = input.decision === "allow_once" || input.decision === "allow_always";
  await createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(input.threadId)).resolve(
    toolApprovalInterruptionId(input.requestId),
    {
      status: approved ? "approved" : "rejected",
      resolution: {
        decision: approved ? "approve" : "reject",
        rememberDecision: input.decision === "allow_always"
      }
    }
  );
}

export async function updateToolApprovalSession(input: {
  originalThreadId: string;
  approvalThreadId: string;
  request: AgentToolPermissionRequest;
}): Promise<void> {
  const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(input.originalThreadId));
  const current = await store.get(toolApprovalInterruptionId(input.request.requestId));
  if (!current) return;
  const updatedRequest: AgentToolPermissionRequest = {
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

export function resolvePersistedToolApprovalInterruption(input: {
  approvalThreadId: string;
  requestId: string;
  decision: AgentToolPermissionDecision;
}): boolean {
  const matched = listPendingRuntimeCoreInterruptionRecords().find((record) => {
    const payload = record.interruption.payload as AgentToolPermissionRequest;
    return (record.interruption.type === "tool_approval" || record.interruption.type === "automation_approval")
      && payload?.requestId === input.requestId
      && record.interruption.threadId === input.approvalThreadId;
  });
  if (!matched) return false;
  return resolveFileBackedInterruptionSync(
    matched.sessionDir,
    toolApprovalInterruptionId(input.requestId),
    {
      status: input.decision === "deny" ? "rejected" : "approved",
      resolution: {
        decision: input.decision === "deny" ? "reject" : "approve",
        rememberDecision: input.decision === "allow_always"
      }
    }
  );
}
