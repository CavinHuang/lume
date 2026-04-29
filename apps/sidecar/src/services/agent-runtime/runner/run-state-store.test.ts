import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
    const byThread = await store.listByThread("thread-1");
    expect(byThread.map((state) => state.runId)).toEqual(["run-1", "run-2"]);
    expect((await store.findActiveByThread("thread-1"))?.runId).toBe("run-1");
  });
});
