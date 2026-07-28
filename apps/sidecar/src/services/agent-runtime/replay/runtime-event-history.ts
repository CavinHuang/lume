import type { AgentThreadRuntimeEventsResult, LumeRuntimeEvent } from "@lume/shared";
import { projectBackgroundTaskNotificationRuntimeEvent, projectRunStateToRuntimeEvents } from "../runner/run-item-events";
import { createFileBackedLumeRunStateStore } from "../runner/run-state-store";
import { createFileBackedTaskStore } from "../task/task-store";
import { getAgentThreadSDKMessages } from "../../agent/agent-thread-manager";

export async function listThreadRuntimeEvents(input: {
  sessionDir: string;
  threadId: string;
}): Promise<AgentThreadRuntimeEventsResult> {
  const runs = await createFileBackedLumeRunStateStore(input.sessionDir).listByThread(input.threadId);
  const taskEvents = createFileBackedTaskStore(input.sessionDir, { taskListId: input.threadId }).listEvents();
  const backgroundTaskEvents = getAgentThreadSDKMessages(input.threadId)
    .filter((message) => message.type === "system" && message.subtype === "task_notification")
    .map((message) => {
      const createdAt = (message as SDKMessageWithCreatedAt)._createdAt;
      return projectBackgroundTaskNotificationRuntimeEvent(
        input.threadId,
        message,
        typeof createdAt === "number" ? new Date(createdAt).toISOString() : new Date(0).toISOString()
      );
    })
    .filter((event): event is Extract<LumeRuntimeEvent, { type: "background.task.completed" }> => event !== null);

  return {
    threadId: input.threadId,
    events: assignRunSequences(sortRuntimeEvents([
      ...runs.flatMap((run) => projectRunStateToRuntimeEvents(run)),
      ...backgroundTaskEvents,
      ...taskEvents.map((event) => ({
        id: `task.progress:${event.taskListId}:${event.sequence}`,
        type: "task.progress" as const,
        threadId: input.threadId,
        runId: input.threadId,
        taskListId: event.taskListId,
        origin: event.origin,
        status: event.tasks.some((task) => task.status === "in_progress")
          ? "in_progress" as const
          : event.tasks.length > 0 && event.tasks.every((task) => task.status === "completed")
            ? "completed" as const
            : "pending" as const,
        currentTaskId: event.tasks.find((task) => task.status === "in_progress")?.id,
        tasks: event.tasks,
        message: event.message,
        createdAt: event.createdAt,
        sequence: event.sequence,
      }))
    ]))
  };
}

type SDKMessageWithCreatedAt = { _createdAt?: number };

/** Event timestamps can collide across parallel child runs; sequence is the stable order within one run. */
function assignRunSequences(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  const nextByRun = new Map<string, number>();
  return events.map((event) => {
    if (event.type === "task.progress" && event.taskListId && event.sequence !== undefined) return event;
    const next = nextByRun.get(event.runId) ?? 0;
    nextByRun.set(event.runId, next + 1);
    return { ...event, sequence: next };
  });
}

function sortRuntimeEvents(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  return [...events].sort((a, b) => {
    const timeOrder = a.createdAt.localeCompare(b.createdAt);
    if (timeOrder !== 0) return timeOrder;
    return eventOrder(a) - eventOrder(b);
  });
}

function eventOrder(event: LumeRuntimeEvent): number {
  if (event.type === "run.started") return 0;
  if (event.type === "message.user.submitted") return 1;
  if (event.type.startsWith("assistant.")) return 2;
  if (event.type.startsWith("tool.")) return 3;
  if (event.type === "plan.preview") return 4;
  if (event.type === "im.delivery") return 5;
  if (event.type === "memory.context.used") return 6;
  if (event.type === "task.progress") return 7;
  if (event.type.startsWith("run.")) return 8;
  return 9;
}
