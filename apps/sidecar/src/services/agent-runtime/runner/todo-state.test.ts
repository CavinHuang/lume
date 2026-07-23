import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LumeRunState } from "./run-state";
import { createFileBackedLumeRunStateStore } from "./run-state-store";
import { cloneTodoState, getTodoCompletionBlocker, readLatestTodoState } from "./todo-state";

function makeState(runId: string, threadId: string, createdAt: string): LumeRunState {
  return {
    version: 1,
    runId,
    threadId,
    rootAgentId: "root",
    currentAgentId: "root",
    status: "completed",
    input: { userMessage: "continue", permissionMode: "default" },
    generatedItems: [],
    pendingInterruptions: [],
    approvals: { alwaysAllowedTools: [] },
    traceId: `trace-${runId}`,
    model: { provider: "openai", modelId: "gpt-test" },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt,
    updatedAt: createdAt
  };
}

describe("readLatestTodoState", () => {
  test("returns the newest persisted snapshot for the requested thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-todo-state-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-1", "thread-1", "2026-07-16T00:00:00.000Z"));
    await store.appendItem("run-1", {
      type: "todo_state",
      id: "todo-1",
      todos: [{ content: "Old", activeForm: "Doing old", status: "in_progress" }],
      currentActiveForm: "Doing old",
      createdAt: "2026-07-16T00:00:01.000Z"
    });
    await store.create(makeState("run-2", "thread-1", "2026-07-16T00:00:02.000Z"));
    await store.appendItem("run-2", {
      type: "todo_state",
      id: "todo-2",
      todos: [{ content: "New", activeForm: "Doing new", status: "in_progress" }],
      currentActiveForm: "Doing new",
      createdAt: "2026-07-16T00:00:03.000Z"
    });
    await store.create(makeState("other-run", "thread-2", "2026-07-16T00:00:04.000Z"));
    await store.appendItem("other-run", {
      type: "todo_state",
      id: "todo-other",
      todos: [{ content: "Other", activeForm: "Doing other", status: "in_progress" }],
      currentActiveForm: "Doing other",
      createdAt: "2026-07-16T00:00:05.000Z"
    });

    expect(await readLatestTodoState({ sessionDir: dir, threadId: "thread-1" })).toEqual({
      todos: [{ content: "New", activeForm: "Doing new", status: "in_progress" }],
      currentActiveForm: "Doing new"
    });
  });

  test("preserves a latest empty snapshot after all todos complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-todo-state-empty-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-1", "thread-1", "2026-07-16T00:00:00.000Z"));
    await store.appendItem("run-1", {
      type: "todo_state",
      id: "todo-active",
      todos: [{ content: "Task", activeForm: "Doing task", status: "in_progress" }],
      currentActiveForm: "Doing task",
      createdAt: "2026-07-16T00:00:01.000Z"
    });
    await store.appendItem("run-1", {
      type: "todo_state",
      id: "todo-cleared",
      todos: [],
      currentActiveForm: null,
      createdAt: "2026-07-16T00:00:02.000Z"
    });

    expect(await readLatestTodoState({ sessionDir: dir, threadId: "thread-1" })).toEqual({
      todos: [],
      currentActiveForm: null
    });
  });
});

describe("todo completion guard", () => {
  test("blocks final completion while todo items remain", () => {
    const state = {
      todos: [
        { content: "Inspect code", activeForm: "Inspecting code", status: "completed" as const },
        { content: "Fix bug", activeForm: "Fixing bug", status: "in_progress" as const },
        { content: "Run tests", activeForm: "Running tests", status: "pending" as const }
      ],
      currentActiveForm: "Fixing bug"
    };

    const blocker = getTodoCompletionBlocker(state);
    expect(blocker).toContain("[todo incomplete]");
    expect(blocker).toContain("正在进行：Fix bug");
    expect(blocker).toContain("[~] Fix bug");
    expect(blocker).toContain("[ ] Run tests");
    expect(blocker).toContain("不要直接给出最终答复");
  });

  test("allows completion after the list is cleared and clones snapshots defensively", () => {
    expect(getTodoCompletionBlocker(null)).toBeUndefined();
    expect(getTodoCompletionBlocker({ todos: [], currentActiveForm: null })).toBeUndefined();

    const source = {
      todos: [{ content: "Task", activeForm: "Doing task", status: "in_progress" as const }],
      currentActiveForm: "Doing task"
    };
    const cloned = cloneTodoState(source);
    cloned.todos[0]!.content = "Changed";
    expect(source.todos[0]!.content).toBe("Task");
  });
});
