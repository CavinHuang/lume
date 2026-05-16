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
    events: sortRuntimeEvents([
      ...runs.flatMap((run) => projectRunStateToRuntimeEvents(run)),
      ...taskRuns.flatMap((taskRun) => projectTaskRunToRuntimeEvents(input.threadId, taskRun))
    ])
  };
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
  if (event.type === "task.progress") return 5;
  if (event.type.startsWith("run.")) return 6;
  return 9;
}
