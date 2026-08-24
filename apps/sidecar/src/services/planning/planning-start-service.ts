import { createHash } from "node:crypto";
import type { AgentUserMessagePart, PlanningTodoStartInput, PlanningTodoStartResult } from "@lume/shared";
import { planningTodoUri } from "@lume/shared";
import { appendAgentMessage } from "../agent/agent-service";
import { createAgentNotificationEmitter } from "../agent/agent-notification-service";
import { getAgentSubmissionStore } from "../agent/agent-submission-store";
import { createAgentThreadWithModelRef, deleteAgentThread, getAgentThreadMessages, getAgentThreadMeta } from "../agent/agent-thread-manager";
import { isAgentRuntimeSessionActive } from "../agent-runtime/runner/attempt";
import { issuePlanningScopeGrant, registerPlanningExecutionContext } from "./planning-execution-context";
import { getPlanningTodoStore } from "./planning-todo-store";

export function startPlanningTodo(input: PlanningTodoStartInput, mode: "start" | "continue" = "start"): PlanningTodoStartResult {
  const store = getPlanningTodoStore();
  let todo = store.get(input.todoId, false);
  if (todo.revision !== input.expectedRevision) throw new Error("Planning Todo revision 冲突");
  if (todo.workspaceId && input.workspaceId && input.workspaceId !== todo.workspaceId) throw new Error("目标项目与 Todo 归属不一致");
  if (!todo.workspaceId) {
    if (!input.workspaceId) throw new Error("未分配 Todo 开始处理前需要选择项目");
    todo = store.update({ todoId: todo.id, expectedRevision: todo.revision, patch: { workspaceId: input.workspaceId } }).todo!;
  }
  // The idempotency key is the durable logical submission identity. Keeping it
  // stable also lets a retry recover a receipt after the response was lost.
  const clientSubmissionId = submissionIdForOperation(input.idempotencyKey);
  const operationKind = mode === "continue" && input.newThread ? "start" : mode;
  let operation = store.reserveOperation({ operationId: input.idempotencyKey, kind: operationKind, todoId: todo.id, clientSubmissionId });
  if (operation.status === "completed" || operation.status === "partial" || operation.status === "reconciling") {
    const existingThreadId = operation.threadId;
    if (existingThreadId) return { schemaVersion: 1, operation, threadId: existingThreadId, todo: store.get(todo.id, false) };
  }
  // 补偿终态（#647 P1-6）：空线程已删且无回执，同 key 重试不得复活幽灵 threadId，
  // 如实返回补偿后的 envelope 由调用方感知失败。
  if (operation.status === "compensated") {
    return { schemaVersion: 1, operation, todo: store.get(todo.id, false) };
  }

  const linked = store.listPrimaryThreads(todo.id);
  const candidate = input.newThread ? undefined : linked.find((item) => item.lifecycle !== "tombstone");
  let threadId = operation.threadId ?? candidate?.threadId;
  let createdThreadId: string | undefined;
  if (!threadId && operation.kind === "continue") {
    operation = store.advanceOperation(operation.operationId, {
      phase: "reconciled",
      status: "failed",
      recoverable: false,
      error: "没有可继续处理的关联任务",
    });
    return { schemaVersion: 1, operation, todo: store.get(todo.id, false) };
  }
  if (threadId && isAgentRuntimeSessionActive(threadId)) {
    operation = store.advanceOperation(operation.operationId, { phase: "finalized", status: "completed", recoverable: false, threadId });
    return { schemaVersion: 1, operation, threadId, todo: store.get(todo.id, false) };
  }

  try {
    if (!threadId) {
      const thread = createAgentThreadWithModelRef(`处理：${todo.title}`, undefined, undefined, todo.workspaceId, undefined, undefined, { planningOperationId: operation.operationId, planningTodoId: todo.id });
      threadId = thread.id;
      createdThreadId = thread.id;
      operation = store.advanceOperation(operation.operationId, { phase: "thread_created", status: "running", threadId });
    }
    registerPlanningExecutionContext({ surface: "main", threadId, workspaceId: todo.workspaceId, clientSubmissionId, continuationOperationId: operation.operationId });
    issuePlanningScopeGrant({ clientSubmissionId, surface: "main", scope: "todo", workspaceId: todo.workspaceId, todoIds: [todo.id], allowedOperations: ["get", "start"], mode: "turn" });
    const part: AgentUserMessagePart = { type: "planning_todo_ref", schemaVersion: 1, uri: planningTodoUri(todo.id), todoId: todo.id, relation: "primary", displayText: todo.title };
    const dispatch = appendAgentMessage({
      threadId,
      userMessage: `&${todo.title}`,
      messageParts: [part],
      workspaceId: todo.workspaceId,
      clientSubmissionId,
      trustedPlanningClientSubmissionId: clientSubmissionId,
      traceContext: { submissionId: clientSubmissionId, origin: "internal" }
    }, createAgentNotificationEmitter({ threadId }), { trustedPlanningOperationId: operation.operationId });
    operation = store.advanceOperation(operation.operationId, { phase: "submission_accepted", status: "running", threadId });
    store.link(todo.id, { threadId, relation: "primary", runId: clientSubmissionId });
    operation = store.advanceOperation(operation.operationId, { phase: "link_committed", status: "running", threadId });
    operation = store.advanceOperation(operation.operationId, { phase: "finalized", status: "completed", recoverable: false, threadId });
    void dispatch;
    return { schemaVersion: 1, operation, threadId, todo: store.get(todo.id, false) };
  } catch (error) {
    const latest = store.getOperation(operation.operationId);
    if (latest && latest.phase !== "finalized") {
      const message = error instanceof Error ? error.message : String(error);
      if (createdThreadId && getAgentThreadMessages(createdThreadId).length === 0) {
        try {
          operation = store.advanceOperation(operation.operationId, { phase: "compensating", status: "running", recoverable: true, threadId, error: message });
          deleteAgentThread(createdThreadId);
          operation = store.advanceOperation(operation.operationId, { phase: "reconciled", status: "compensated", compensation: "completed", recoverable: false, error: message });
        } catch (compensationError) {
          operation = store.advanceOperation(operation.operationId, { phase: "reconciled", status: "partial", compensation: "failed", recoverable: true, threadId, error: compensationError instanceof Error ? compensationError.message : message });
        }
      } else {
        operation = store.advanceOperation(operation.operationId, { phase: "reconciled", status: "partial", recoverable: true, threadId, error: message });
      }
    }
    // The operation was durably reserved, so callers receive its recoverable
    // envelope instead of losing the state behind a generic RPC error.
    return { schemaVersion: 1, operation, ...(threadId ? { threadId } : {}), todo: store.get(todo.id, false) };
  }
}

function submissionIdForOperation(operationId: string): string {
  const value = operationId.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return value.toLowerCase();
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Repairs the only cross-store crash window: an accepted submission whose
 * Planning link/final operation event was not committed before shutdown. */
export function reconcilePlanningStartOperations(): void {
  const store = getPlanningTodoStore();
  const submissions = getAgentSubmissionStore();
  const accepted = new Set(["accepted", "queued", "paused", "started", "completed", "interrupted"]);
  const phaseOrder = ["reserved", "thread_created", "submission_accepted", "link_committed", "link_touched", "reconciled", "finalized"];
  for (const candidate of store.listRecoverableOperations(["start", "continue"])) {
    let operation = candidate;
    if (!operation.todoId || !operation.threadId || !operation.clientSubmissionId) continue;
    const todoId = operation.todoId;
    const threadId = operation.threadId;
    const clientSubmissionId = operation.clientSubmissionId;
    const receipt = submissions.get(clientSubmissionId);
    if (!receipt || receipt.threadId !== threadId) {
      // #647 P1-6：thread_created/compensating 相位且无任何 submission 回执，说明
      // 消息从未被接受——护栏（会话不活跃且线程零消息）全过才删空线程。先删后推进：
      // 删除失败时不落任何终态，相位保持原处供下次 boot 重试，避免断头终态使
      // recoverable=true 沦为空头承诺、孤儿线程永久滞留。
      if (operation.phase === "thread_created" || operation.phase === "compensating") {
        try {
          if (!isAgentRuntimeSessionActive(threadId) && getAgentThreadMessages(threadId).length === 0) {
            // meta 已缺失＝线程已被删除（用户手删或上轮已清）：直接收敛，不对幽灵线程重复 delete
            if (getAgentThreadMeta(threadId)) deleteAgentThread(threadId);
            operation = store.advanceOperation(operation.operationId, { phase: "compensating", status: "running", recoverable: true, threadId });
            store.advanceOperation(operation.operationId, { phase: "reconciled", status: "compensated", compensation: "completed", recoverable: false, threadId });
          }
        } catch { /* 保持当前相位等待下次 boot 重试 */ }
      }
      continue;
    }
    try {
      if (accepted.has(receipt.status)) {
        if (phaseOrder.indexOf(operation.phase) < phaseOrder.indexOf("submission_accepted")) {
          operation = store.advanceOperation(operation.operationId, { phase: "submission_accepted", status: "reconciling", threadId });
        }
        store.link(todoId, { threadId, relation: "primary", runId: clientSubmissionId });
        const linkPhase = operation.kind === "continue" ? "link_touched" : "link_committed";
        if (phaseOrder.indexOf(operation.phase) < phaseOrder.indexOf(linkPhase)) {
          operation = store.advanceOperation(operation.operationId, { phase: linkPhase, status: "reconciling", threadId });
        }
        store.advanceOperation(operation.operationId, { phase: "finalized", status: "completed", recoverable: false, threadId });
      } else if (["rejected", "failed", "restart_dropped"].includes(receipt.status)) {
        store.advanceOperation(operation.operationId, { phase: "reconciled", status: "partial", recoverable: true, threadId, error: receipt.errorCode ?? `submission ${receipt.status}` });
      }
    } catch (error) {
      try {
        store.advanceOperation(operation.operationId, { phase: "reconciled", status: "partial", recoverable: true, threadId, error: error instanceof Error ? error.message : String(error) });
      } catch { /* keep the last durable operation state for the next retry */ }
    }
  }
}
