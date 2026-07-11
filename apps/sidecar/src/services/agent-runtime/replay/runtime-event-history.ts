import type { AgentThreadRuntimeEventsResult, LumeRuntimeEvent } from "@lume/shared";
import { projectRunStateToRuntimeEvents } from "../runner/run-item-events";
import { createFileBackedLumeRunStateStore } from "../runner/run-state-store";
import { projectTaskRunToRuntimeEvents } from "../task-run/task-progress-events";
import { createFileBackedTaskRunStore } from "../task-run/task-run-store";

export async function listThreadRuntimeEvents(input: {
  sessionDir: string;
  threadId: string;
}): Promise<AgentThreadRuntimeEventsResult> {
  const [runs, taskRuns] = await Promise.all([
    createFileBackedLumeRunStateStore(input.sessionDir).listByThread(input.threadId),
    createFileBackedTaskRunStore(input.sessionDir).listByThread(input.threadId)
  ]);

  return {
    threadId: input.threadId,
    events: assignRunSequences(sortRuntimeEvents([
      ...runs.flatMap((run) => projectRunStateToRuntimeEvents(run)),
      ...taskRuns.flatMap((taskRun) => projectTaskRunToRuntimeEvents(input.threadId, taskRun))
    ]))
  };
}

/** Event timestamps can collide across parallel child runs; sequence is the stable order within one run. */
function assignRunSequences(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  const nextByRun = new Map<string, number>();
  return events.map((event) => {
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
