import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeRunStateStore } from "./run-state-store";
import { projectRunStateToRuntimeEvents } from "./run-item-events";
import { readLatestTodoState } from "./todo-state";
import type { LumeRunState } from "./run-state";

function makeState(runId: string, status: LumeRunState["status"]): LumeRunState {
  const now = new Date("2026-04-29T00:00:00.000Z").toISOString();
  return {
    version: 1,
    runId,
    threadId: "thread-1",
    rootAgentId: "root",
    currentAgentId: "root",
    status,
    input: {
      userMessage: "hello",
      permissionMode: "default"
    },
    generatedItems: [],
    pendingInterruptions: [],
    approvals: {
      alwaysAllowedTools: []
    },
    traceId: `trace-${runId}`,
    model: {
      provider: "openai",
      modelId: "gpt-test"
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    },
    createdAt: now,
    updatedAt: now
  };
}

describe("run-state-store", () => {
  test("persists run state, appended items, and active run lookup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);

    await store.create(makeState("run-1", "running"));
    await store.appendItem("run-1", {
      type: "system_event",
      id: "item-1",
      name: "started",
      createdAt: "2026-04-29T00:00:01.000Z"
    });
    await store.update("run-1", {
      status: "waiting_for_approval",
      currentStep: {
        id: "step-1",
        type: "tool_approval",
        status: "running"
      }
    });

    const stored = await store.get("run-1");
    expect(stored?.status).toBe("waiting_for_approval");
    expect(stored?.currentStep?.type).toBe("tool_approval");
    expect(stored?.generatedItems).toEqual([
      {
        type: "system_event",
        id: "item-1",
        name: "started",
        createdAt: "2026-04-29T00:00:01.000Z"
      }
    ]);

    await store.create(makeState("run-2", "completed"));
    writeFileSync(join(dir, "runs", "run-2.continuation.json"), JSON.stringify({
      version: 1,
      runId: "run-2",
      threadId: "thread-1",
      status: "ready_to_resume"
    }));
    const byThread = await store.listByThread("thread-1");
    expect(byThread.map((state) => state.runId)).toEqual(["run-1", "run-2"]);
    expect((await store.findActiveByThread("thread-1"))?.runId).toBe("run-1");
  });

  test("多次 appendItem 累积后 get 返回全部 items（append-only 正确性）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-acc", "running"));
    for (let i = 1; i <= 5; i++) {
      await store.appendItem("run-acc", {
        type: "system_event", id: `item-${i}`, name: "n", createdAt: `2026-04-29T00:00:0${i}.000Z`
      });
    }
    const stored = await store.get("run-acc");
    expect(stored?.generatedItems.map((i) => i.id)).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);
  });

  test("update 不含 generatedItems 时不改动 items.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-u1", "running"));
    await store.appendItem("run-u1", { type: "system_event", id: "keep-1", name: "n", createdAt: "2026-04-29T00:00:01.000Z" });
    await store.update("run-u1", { status: "waiting_for_approval" });
    const stored = await store.get("run-u1");
    expect(stored?.status).toBe("waiting_for_approval");
    expect(stored?.generatedItems.map((i) => i.id)).toEqual(["keep-1"]);
  });

  test("update 含 generatedItems 时重写 items（handoff 兼容）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-u2", "running"));
    await store.appendItem("run-u2", { type: "system_event", id: "orig-1", name: "n", createdAt: "2026-04-29T00:00:01.000Z" });
    await store.update("run-u2", {
      generatedItems: [
        { type: "system_event", id: "orig-1", name: "n", createdAt: "2026-04-29T00:00:01.000Z", handoff: true } as any,
        { type: "system_event", id: "new-2", name: "n", createdAt: "2026-04-29T00:00:02.000Z" }
      ]
    });
    const stored = await store.get("run-u2");
    expect(stored?.generatedItems.map((i) => i.id)).toEqual(["orig-1", "new-2"]);
    expect((stored?.generatedItems[0] as any).handoff).toBe(true);
  });

  test("listStatesByThread 不解析 items 且排序与 listByThread 一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-b", "running"));
    await store.appendItem("run-b", { type: "system_event", id: "item-b", name: "n", createdAt: "2026-04-29T00:00:01.000Z" });
    await store.create(makeState("run-a", "completed"));

    const states = await store.listStatesByThread("thread-1");
    expect(states.map((state) => state.runId)).toEqual(["run-a", "run-b"]);
    expect(states.every((state) => state.generatedItems.length === 0)).toBe(true);
    expect((await store.getState("run-b"))?.generatedItems.length).toBe(0);
    expect(await store.countItems("run-b")).toBe(1);
    expect(await store.countItems("run-a")).toBe(0);
  });

  test("compactModelStreamItems：有 assistant_message 时滤掉 model_stream，无则不动", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-with-final", "completed"));
    await store.appendItem("run-with-final", { type: "model_stream", id: "d1", event: { type: "stream_event" } as any, createdAt: "2026-04-29T00:00:01.000Z" });
    await store.appendItem("run-with-final", { type: "assistant_message", id: "a1", content: [{ type: "text", text: "final answer" }] as any, createdAt: "2026-04-29T00:00:02.000Z" });
    await store.appendItem("run-with-final", { type: "model_stream", id: "d2", event: { type: "stream_event" } as any, createdAt: "2026-04-29T00:00:03.000Z" });

    await store.compactModelStreamItems("run-with-final");
    expect((await store.get("run-with-final"))?.generatedItems.map((i) => i.id)).toEqual(["a1"]);

    // 无 assistant_message：依赖 model_stream 重建文本，不裁
    await store.create(makeState("run-no-final", "failed"));
    await store.appendItem("run-no-final", { type: "model_stream", id: "d3", event: { type: "stream_event" } as any, createdAt: "2026-04-29T00:00:01.000Z" });
    await store.compactModelStreamItems("run-no-final");
    expect((await store.get("run-no-final"))?.generatedItems.map((i) => i.id)).toEqual(["d3"]);
  });

  test("compact 后 hydrate 投影不变（有 assistant_message 的 run）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-proj", "completed"));
    await store.appendItem("run-proj", { type: "model_stream", id: "d1", event: { type: "stream_event" } as any, createdAt: "2026-04-29T00:00:01.000Z" });
    await store.appendItem("run-proj", { type: "assistant_message", id: "a1", content: [{ type: "text", text: "final answer" }] as any, createdAt: "2026-04-29T00:00:02.000Z" });

    const before = projectRunStateToRuntimeEvents((await store.get("run-proj"))!);
    await store.compactModelStreamItems("run-proj");
    const after = projectRunStateToRuntimeEvents((await store.get("run-proj"))!);
    expect(after).toEqual(before);
  });

  test("todo 快照 save/read 往返，readLatestTodoState 优先快照", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    store.saveTodoSnapshot("thread-s", {
      todos: [{ content: "Step", activeForm: "Doing", status: "in_progress" }],
      currentActiveForm: "Doing",
      runId: "r1",
      createdAt: "2026-04-29T00:00:00.000Z"
    });
    expect(store.readTodoSnapshot("thread-s")?.todos[0]?.content).toBe("Step");

    // 快照优先：即使 items 里有更新的 todo_state 也返回快照（快照由唯一写点同步更新）
    await store.create(makeState("run-s", "completed"));
    await store.appendItem("run-s", {
      type: "todo_state",
      id: "t-newer",
      todos: [{ content: "Stale item path", activeForm: "x", status: "pending" }],
      currentActiveForm: "x",
      createdAt: "2026-04-29T00:00:09.000Z"
    });
    expect(await readLatestTodoState({ sessionDir: dir, threadId: "thread-s" })).toEqual({
      todos: [{ content: "Step", activeForm: "Doing", status: "in_progress" }],
      currentActiveForm: "Doing"
    });
  });
});
