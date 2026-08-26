import type {
  AgentToolPermissionDecision,
  AgentToolPermissionRequest
} from "@lume/shared";
import { createHash } from "node:crypto";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import type { LumeInterruption } from "./interruption";
import { listPendingRuntimeCoreInterruptionRecords } from "./interruption-pending";
import {
  createFileBackedLumeInterruptionStore,
  resolveFileBackedInterruptionSync
} from "./interruption-store";
import { createFileBackedRunContinuationStore } from "../runtime-core/run-continuation-store";
import { createLogger } from "../../infra/logger";

const log = createLogger("approval-service");

export function toolApprovalInterruptionId(requestId: string): string {
  return `tool_approval:${requestId}`;
}

export async function persistToolApprovalInterruption(request: AgentToolPermissionRequest): Promise<LumeInterruption> {
  const now = new Date().toISOString();
  const type = request.interruptionType ?? "tool_approval";
  const interruption: LumeInterruption = {
    id: toolApprovalInterruptionId(request.requestId),
    runId: request.runId,
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
  const sessionDir = getRuntimeCoreSessionDir(request.threadId);
  const writes: Array<Promise<void>> = [
    createFileBackedLumeInterruptionStore(sessionDir).upsert(interruption)
  ];
  if (request.runId) {
    writes.push(createFileBackedRunContinuationStore(sessionDir).upsert({
      version: 2,
      runId: request.runId,
      threadId: request.threadId,
      status: "waiting_for_interruption",
      checkpoint: {
        step: "before_tool_execution",
        interruptionId: interruption.id,
        toolCallId: request.toolUseId,
        toolName: request.toolName,
        toolKind: classifyToolKind(request.toolName),
        toolCall: {
          id: request.toolUseId,
          name: request.toolName,
          input: request.input,
          inputHash: hashToolInput(request.input),
          kind: classifyToolKind(request.toolName)
        }
      },
      reason: "等待工具审批。",
      createdAt: now,
      updatedAt: now
    }));
  }
  await Promise.all(writes);
  return interruption;
}

export async function resolveToolApprovalInterruption(input: {
  threadId: string;
  requestId: string;
  decision: AgentToolPermissionDecision | null;
}): Promise<void> {
  const approved = input.decision === "allow_once" || input.decision === "allow_always";
  const sessionDir = getRuntimeCoreSessionDir(input.threadId);
  const store = createFileBackedLumeInterruptionStore(sessionDir);
  const current = await store.get(toolApprovalInterruptionId(input.requestId));
  // resolve 返回 false=记录缺失或已被并发路径（cancel/超时）收口：不得再用 stale 快照写 continuation
  const migrated = await store.resolve(
    toolApprovalInterruptionId(input.requestId),
    {
      status: approved ? "approved" : "rejected",
      resolution: {
        decision: approved ? "approve" : "reject",
        rememberDecision: input.decision === "allow_always"
      }
    }
  );
  if (!migrated) return;
  if (current?.runId) {
    const payload = current.payload as AgentToolPermissionRequest;
    await createFileBackedRunContinuationStore(sessionDir).update(current.runId, {
      status: approved ? "ready_to_execute" : "ready_to_resume",
      checkpoint: {
        step: approved ? "before_tool_execution" : "after_tool_result",
        interruptionId: current.id,
        toolCallId: payload.toolUseId,
        toolName: payload.toolName,
        toolKind: classifyToolKind(payload.toolName),
        toolCall: {
          id: payload.toolUseId,
          name: payload.toolName,
          input: payload.input,
          inputHash: hashToolInput(payload.input),
          kind: classifyToolKind(payload.toolName)
        },
        syntheticToolResult: {
          status: approved ? "approved" : "rejected",
          decision: input.decision ?? "deny",
          rememberDecision: input.decision === "allow_always",
          note: approved ? "工具审批已通过，原工具调用尚未执行。" : "工具审批已拒绝，原工具调用不会执行。"
        }
      },
      reason: approved
        ? "工具审批已解决；冷启动恢复必须使用保存的输入执行原工具调用一次。"
        : "工具审批已拒绝；冷启动恢复将注入拒绝结果。"
    });
  }
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
  const resolved = resolveFileBackedInterruptionSync(
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
  if (resolved && matched.interruption.runId) {
    const payload = matched.interruption.payload as AgentToolPermissionRequest;
    const approved = input.decision === "allow_once" || input.decision === "allow_always";
    void createFileBackedRunContinuationStore(matched.sessionDir).update(matched.interruption.runId, {
      status: approved ? "ready_to_execute" : "ready_to_resume",
      checkpoint: {
        step: approved ? "before_tool_execution" : "after_tool_result",
        interruptionId: matched.interruption.id,
        toolCallId: payload.toolUseId,
        toolName: payload.toolName,
        toolKind: classifyToolKind(payload.toolName),
        toolCall: {
          id: payload.toolUseId,
          name: payload.toolName,
          input: payload.input,
          inputHash: hashToolInput(payload.input),
          kind: classifyToolKind(payload.toolName)
        },
        syntheticToolResult: {
          status: approved ? "approved" : "rejected",
          decision: input.decision,
          rememberDecision: input.decision === "allow_always",
          note: approved ? "工具审批已通过，原工具调用尚未执行。" : "工具审批已拒绝，原工具调用不会执行。"
        }
      },
      reason: approved
        ? "工具审批已解决；冷启动恢复必须使用保存的输入执行原工具调用一次。"
        : "工具审批已拒绝；冷启动恢复将注入拒绝结果。"
    }).catch((error) => {
      // fire-and-forget 持久化失败只降级冷启动恢复能力，不允许变成未处理拒绝崩进程
      log.warn("Failed to persist approval continuation", {
        threadId: matched.interruption.threadId,
        runId: matched.interruption.runId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return resolved;
}

export function hashToolInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
}

export function classifyToolKind(toolName: string): "read" | "write" | "execute" | "control" {
  const normalized = toolName.toLowerCase();
  if (normalized === "read" || normalized === "glob" || normalized === "grep" || normalized === "processoutput") return "read";
  if (normalized === "write" || normalized === "edit" || normalized === "notebookedit") return "write";
  if (normalized === "askuserquestion") return "control";
  return "execute";
}
