import { createTaskTools, type TaskToolName, type ToolDefinition } from "@lume/agent-sdk";
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
  input.emitRuntimeEvent?.({
    id: `task.progress:${notification.taskListId}:${notification.sequence}`,
    type: "task.progress",
    threadId: input.threadId,
    runId: input.runId ?? input.threadId,
    taskListId: notification.taskListId,
    sequence: notification.sequence,
    origin: notification.origin,
    status: active ? "in_progress" : notification.tasks.every((task) => task.status === "completed") ? "completed" : "pending",
    currentTaskId: active?.id,
    tasks: notification.tasks,
    message: notification.message,
    createdAt: new Date().toISOString(),
  });
}

export const MAIN_TASK_TOOL_NAMES: ReadonlySet<TaskToolName> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
]);
