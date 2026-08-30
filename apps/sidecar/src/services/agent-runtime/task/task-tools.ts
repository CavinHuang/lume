import { createTaskTools, type Task, type ToolDefinition } from "@lume/agent-sdk";
import type { LumeRuntimeEvent } from "@lume/shared";
import { createFileBackedTaskStore, type TaskStoreNotification } from "./task-store";

/* 完成门控用的最小结构视图（store 的 Task 结构性兼容） */
export interface TaskCompletionSnapshot {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

/* ZCode 式完成门控：run 收尾时若本 run 触碰过的任务仍有未完成项，
 * 返回继续推进的反馈文本（无未完成项时返回 undefined 放行收尾）。 */
export function getTaskCompletionBlocker(tasks: TaskCompletionSnapshot[]): string | undefined {
  const remaining = tasks.filter((task) => task.status !== "completed");
  if (remaining.length === 0) return undefined;
  const active = remaining.find((task) => task.status === "in_progress");
  const preview = remaining
    .slice(0, 5)
    .map((task) => `${task.status === "in_progress" ? "[~]" : "[ ]"} ${task.subject}`)
    .join("\n");
  const omitted = remaining.length > 5 ? `\n...以及另外 ${remaining.length - 5} 项` : "";
  return [
    `[task incomplete] 当前任务清单仍有 ${remaining.length} 项未完成${active ? `，正在进行：${active.subject}` : ""}。`,
    preview + omitted,
    "不要直接给出最终答复。请继续实际执行：开始一项前用 TaskUpdate 将它认领为唯一的 in_progress，完成并验证后立即标记 completed，再推进下一项；确实无法完成的用 TaskStop 释放回 pending 并说明原因。不要仅为了关闭清单而虚假标记完成。",
  ].join("\n");
}

export function createMainTaskTools(input: {
  sessionDir: string;
  threadId: string;
  runId?: string;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onCancellationRequested?: (input: { taskId: string; claimToken?: string; executorRef?: string }) => void;
}): {
  tools: ToolDefinition[];
  store: ReturnType<typeof createFileBackedTaskStore>;
  getUnfinishedTouchedTasks: () => TaskCompletionSnapshot[];
} {
  // 本 run 触碰过的任务快照（create/update 的主变更任务），供完成门控界定范围：
  // 只门控本 run 实际做过的工作，避免历史线程的陈旧 pending 劫持新 run 收尾。
  const touchedTasks = new Map<string, Task>();
  const store = createFileBackedTaskStore(input.sessionDir, {
    taskListId: input.threadId,
    onNotification: (notification) => {
      if (notification.task) touchedTasks.set(notification.task.id, notification.task);
      emitTaskProgress(input, notification);
    },
    onCancellationRequested: input.onCancellationRequested,
  });
  const tools = createTaskTools({
    store,
    context: {
      threadId: input.threadId,
      threadType: "main",
      actorId: `main:${input.threadId}`,
    },
    getRunId: () => input.runId,
  });
  return {
    tools,
    store,
    getUnfinishedTouchedTasks: () =>
      [...touchedTasks.values()]
        .filter((task) => task.status !== "completed")
        .map((task) => ({ id: task.id, subject: task.subject, status: task.status })),
  };
}

function emitTaskProgress(input: {
  threadId: string;
  runId?: string;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
}, notification: TaskStoreNotification): void {
  const active = notification.tasks.find((task) => task.status === "in_progress");
  const completedCount = notification.tasks.filter((task) => task.status === "completed").length;
  // 派生规则：有人在跑 → in_progress；全部完成 → completed；
  // 有已完成产出但工作未完 → in_progress（不能回落 pending，否则 UI 永远看不到执行中）
  const status = active
    ? "in_progress"
    : notification.tasks.length > 0 && completedCount === notification.tasks.length
      ? "completed"
      : completedCount > 0
        ? "in_progress"
        : "pending";
  input.emitRuntimeEvent?.({
    id: `task.progress:${notification.taskListId}:${notification.sequence}`,
    type: "task.progress",
    threadId: input.threadId,
    runId: input.runId ?? input.threadId,
    taskListId: notification.taskListId,
    sequence: notification.sequence,
    origin: notification.origin,
    status,
    currentTaskId: active?.id,
    tasks: notification.tasks,
    message: notification.message,
    createdAt: new Date().toISOString(),
  });
}
