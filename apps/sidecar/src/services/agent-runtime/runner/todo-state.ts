import type { TodoState } from "@lume/agent-sdk";
import { createFileBackedLumeRunStateStore } from "./run-state-store";

export function cloneTodoState(state: TodoState | null): TodoState {
  return {
    todos: state?.todos.map((todo) => ({ ...todo })) ?? [],
    currentActiveForm: state?.currentActiveForm ?? null
  };
}

export function getTodoCompletionBlocker(state: TodoState | null): string | undefined {
  const remaining = state?.todos.filter((todo) => todo.status !== "completed") ?? [];
  if (remaining.length === 0) return undefined;

  const active = remaining.find((todo) => todo.status === "in_progress");
  const preview = remaining
    .slice(0, 5)
    .map((todo) => `${todo.status === "in_progress" ? "[~]" : "[ ]"} ${todo.content}`)
    .join("\n");
  const omitted = remaining.length > 5 ? `\n...以及另外 ${remaining.length - 5} 项` : "";

  return [
    `[todo incomplete] 当前 TodoWrite 仍有 ${remaining.length} 项未完成${active ? `，正在进行：${active.content}` : ""}。`,
    preview + omitted,
    "不要直接给出最终答复。请按 TODO 顺序继续实际执行：开始一项时用 TodoWrite 将它设为唯一的 in_progress，完成并验证后立即标记 completed，再推进下一项。全部完成后必须再次调用 TodoWrite 提交全量完成状态；不要仅为了关闭列表而虚假标记完成。"
  ].join("\n");
}

export async function readLatestTodoState(input: {
  sessionDir: string;
  threadId: string;
}): Promise<TodoState | null> {
  const store = createFileBackedLumeRunStateStore(input.sessionDir);
  // 快照优先：recordTodoState 每次落盘时更新，免全量解析线程全部历史 items
  const snapshot = store.readTodoSnapshot(input.threadId);
  if (snapshot) {
    return {
      todos: snapshot.todos.map((todo) => ({ ...todo })),
      currentActiveForm: snapshot.currentActiveForm
    };
  }

  // 回退：存量线程（快照产生前）全量扫描，并顺带写快照让下次读取走 O(1) 路径
  const runs = await store.listByThread(input.threadId);
  let latest: { state: TodoState; createdAt: string; runId: string } | null = null;

  for (const run of runs) {
    for (const item of run.generatedItems) {
      if (item.type !== "todo_state") continue;
      if (latest && item.createdAt < latest.createdAt) continue;
      latest = {
        state: {
          todos: item.todos.map((todo) => ({ ...todo })),
          currentActiveForm: item.currentActiveForm
        },
        createdAt: item.createdAt,
        runId: run.runId
      };
    }
  }

  if (latest) {
    try {
      store.saveTodoSnapshot(input.threadId, {
        todos: latest.state.todos,
        currentActiveForm: latest.state.currentActiveForm,
        runId: latest.runId,
        createdAt: latest.createdAt
      });
    } catch {
      // 写快照失败不影响本次返回
    }
  }

  return latest?.state ?? null;
}
