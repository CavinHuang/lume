import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeRunStateStore } from "./run-state-store";
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
});
