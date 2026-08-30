import { createTaskTools, type ToolDefinition } from "@lume/agent-sdk";
import type { LumeRuntimeEvent } from "@lume/shared";
import { createFileBackedTaskStore, type TaskStoreNotification } from "./task-store";

export function createMainTaskTools(input: {
  sessionDir: string;
  threadId: string;
  runId?: string;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onCancellationRequested?: (input: { taskId: string; claimToken?: string; executorRef?: string }) => void;
}): { tools: ToolDefinition[]; store: ReturnType<typeof createFileBackedTaskStore> } {
  const store = createFileBackedTaskStore(input.sessionDir, {
    taskListId: input.threadId,
    onNotification: (notification) => emitTaskProgress(input, notification),
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
  return { tools, store };
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
