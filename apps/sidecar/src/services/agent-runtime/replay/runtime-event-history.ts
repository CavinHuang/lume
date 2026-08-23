import type { AgentThreadRuntimeEventsResult, LumeRuntimeEvent } from "@lume/shared";
import { projectRunStateToRuntimeEvents } from "../runtime-core/run-item-events";
import { createFileBackedLumeRunStateStore } from "../runtime-core/run-state-store";
import { createFileBackedTaskStore } from "../task/task-store";
import { getThreadEventBus } from "../events/thread-event-bus";
import { threadStore } from "../agent-thread-store-holder";
import type { LumeRunState } from "../runtime-core/run-state";

/**
 * F4:events.jsonl 有事件(总线恒开后创建的线程)时,run 投影只保留未迁总线的类——
 * assistant/tool/run/todo/compaction/memory.context.used/background.task 等历史由
 * web 端总线快照(GET_EVENTS)单读驱动,旧投影再产一份会 runId 错位无法去重。
 * 旧线程(events.jsonl 空/缺)无快照可读,全量旧投影兜底。
 */
const RETAINED_HYDRATE_EVENT_TYPES = new Set([
  "message.user.submitted",
  "plan.preview",
  "usage.updated"
]);

export function projectRunStateToReplayEvents(run: LumeRunState): LumeRuntimeEvent[] {
  const events = projectRunStateToRuntimeEvents(run);
  if (run.status !== "failed") return events;
  // Failed model output and its transient error remain live-only. On reopen,
  // keep the user's submitted message but do not resurrect a failed answer.
  return events.filter((event) => event.type === "run.started" || event.type === "message.user.submitted");
}

export async function listThreadRuntimeEvents(input: {
  sessionDir: string;
  threadId: string;
}): Promise<AgentThreadRuntimeEventsResult> {
  const runs = await createFileBackedLumeRunStateStore(input.sessionDir).listByThread(input.threadId);
  // F4 分界:总线快照非空 → 该线程历史单读总线,已迁类不再投影;空/缺 → 全量旧投影
  const busHasEvents = getThreadEventBus(input.sessionDir).hasEvents(input.threadId);
  const runEvents = runs
    .flatMap(projectRunStateToReplayEvents)
    .filter((event) => !busHasEvents || RETAINED_HYDRATE_EVENT_TYPES.has(event.type));
  const taskEvents = createFileBackedTaskStore(input.sessionDir, { taskListId: input.threadId }).listEvents();
  // T7a:background.task.completed 已迁事件总线,不再从 SDK log 投影(保留类照旧)
  const memoryChangedEvents = threadStore().getSdkMessages(input.threadId)
    .filter((message) => message.type === "system" && message.subtype === "memory_saved")
    .map((message): Extract<LumeRuntimeEvent, { type: "memory.changed" }> => ({
      id: `${message.run_id}:memory.changed:${message.mutation_ids[0] ?? message.uuid ?? message.created_at}`,
      type: "memory.changed",
      threadId: input.threadId,
      runId: message.run_id,
      createdAt: message.created_at,
      actor: "background_extract",
      workspaceSlug: message.workspace_slug,
      mutationIds: message.mutation_ids,
      memoryIds: message.memory_ids,
      summary: message.summary,
      details: message.details ?? []
    }));

  return {
    threadId: input.threadId,
    events: assignRunSequences(sortRuntimeEvents([
      ...runEvents,
      ...memoryChangedEvents,
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
