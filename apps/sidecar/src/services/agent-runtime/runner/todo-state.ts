import type { TodoState } from "@lume/agent-sdk";
import { createFileBackedLumeRunStateStore } from "./run-state-store";

export async function readLatestTodoState(input: {
  sessionDir: string;
  threadId: string;
}): Promise<TodoState | null> {
  const runs = await createFileBackedLumeRunStateStore(input.sessionDir).listByThread(input.threadId);
  let latest: { state: TodoState; createdAt: string } | null = null;

  for (const run of runs) {
    for (const item of run.generatedItems) {
      if (item.type !== "todo_state") continue;
      if (latest && item.createdAt < latest.createdAt) continue;
      latest = {
        state: {
          todos: item.todos.map((todo) => ({ ...todo })),
          currentActiveForm: item.currentActiveForm
        },
        createdAt: item.createdAt
      };
    }
  }

  return latest?.state ?? null;
}
