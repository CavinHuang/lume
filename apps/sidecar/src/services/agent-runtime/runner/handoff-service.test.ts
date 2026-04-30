import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceRecorder } from "../trace/trace-recorder";
import { createFileBackedLumeTraceStore } from "../trace/trace-store";
import { createFileBackedLumeRunStateStore } from "./run-state-store";
import {
  acceptHandoff,
  completeHandoff,
  failHandoff,
  recordHandoffIntent
} from "./handoff-service";
import type { LumeRunState } from "./run-state";

function createRunState(): LumeRunState {
  return {
    version: 1,
    runId: "run-1",
    threadId: "thread-1",
    rootAgentId: "root-agent",
    currentAgentId: "root-agent",
    status: "running",
    input: { userMessage: "handoff" },
    generatedItems: [],
    pendingInterruptions: [],
    approvals: { alwaysAllowedTools: [] },
    traceId: "trace-1",
    model: { provider: "openai", modelId: "gpt-test" },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z"
  };
}

describe("handoff-service", () => {
  test("records handoff intent as a run item and trace span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-handoff-service-"));
    const runStore = createFileBackedLumeRunStateStore(dir);
    await runStore.create(createRunState());

    const traceStore = createFileBackedLumeTraceStore(dir);
    const recorder = new TraceRecorder(traceStore, {
      createId: () => "span-handoff",
      now: () => "2026-04-30T00:00:01.000Z"
    });
    await traceStore.create({
      id: "trace-1",
      threadId: "thread-1",
      runId: "run-1",
      name: "handoff trace",
      status: "running",
      startedAt: "2026-04-30T00:00:00.000Z",
      spans: []
    });

    const item = await recordHandoffIntent({
      runId: "run-1",
      fromAgentId: "root-agent",
      toAgentId: "reviewer-agent",
      reason: "needs review",
      runStateStore: runStore,
      traceRecorder: recorder,
      traceId: "trace-1"
    });

    expect(item).toMatchObject({
      type: "handoff",
      fromAgentId: "root-agent",
      toAgentId: "reviewer-agent",
      reason: "needs review",
      traceSpanId: "span-handoff"
    });
    expect((await runStore.get("run-1"))?.generatedItems).toEqual([item]);
    expect((await traceStore.get("trace-1"))?.spans[0]).toMatchObject({
      id: "span-handoff",
      type: "handoff",
      name: "root-agent -> reviewer-agent",
      status: "completed"
    });
  });

  test("updates handoff lifecycle and current agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-handoff-lifecycle-"));
    const runStore = createFileBackedLumeRunStateStore(dir);
    await runStore.create(createRunState());
    const item = await recordHandoffIntent({
      runId: "run-1",
      fromAgentId: "root-agent",
      toAgentId: "reviewer-agent",
      runStateStore: runStore
    });

    await acceptHandoff({
      runId: "run-1",
      handoffId: item.id,
      runStateStore: runStore
    });
    expect(await runStore.get("run-1")).toMatchObject({
      currentAgentId: "reviewer-agent",
      generatedItems: [expect.objectContaining({ id: item.id, status: "accepted" })]
    });

    await completeHandoff({
      runId: "run-1",
      handoffId: item.id,
      runStateStore: runStore
    });
    expect((await runStore.get("run-1"))?.generatedItems[0]).toMatchObject({
      id: item.id,
      status: "completed"
    });

    expect(await failHandoff({
      runId: "run-1",
      handoffId: "missing",
      runStateStore: runStore
    })).toBeNull();
  });
});
