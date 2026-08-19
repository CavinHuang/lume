import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS, type SDKMessage } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { getRuntimeCoreSessionDir } from "../services/agent-runtime/runtime-core/session-store";
import { getThreadEventBus } from "../services/agent-runtime/events/thread-event-bus";
import { consumeRuntimeCoreQueryStream } from "../services/agent-runtime/runner/run-loop";
import { resetPlanningTodoStoreForTests } from "../services/planning/planning-todo-store";

// 与 agent-handlers.runtime-state.test.ts 相同的 harness:mock agent-service,
// 使 agent-handlers 顶层 import 不触发真实运行时。
mock.module("../services/agent/agent-service", () => ({
  appendAgentMessage: async () => ({ queued: false }),
  sendAgentMessage: async () => undefined,
  generateAgentTitle: async () => undefined,
  generateWelcomeSuggestions: async () => [],
  listAgentMessageQueue: () => [],
  pauseAgentQueue: () => undefined,
  promoteQueuedAgentMessageToGuidance: () => undefined,
  removeQueuedAgentMessage: () => undefined,
  reorderAgentMessageQueue: () => undefined,
  resumeAgentQueue: () => undefined,
  retryQueuedAgentMessage: () => undefined,
  stopAgent: async () => undefined,
  submitAgentToolPermission: () => false,
  submitAskUserQuestionAnswers: () => ({ ok: true }),
  prepareAgentDispatchInput: async (input: unknown) => input,
  getAgentSubmissionReceipt: () => undefined,
  updateQueuedAgentMessage: () => undefined
}));

function createTestPlanModePhaseTracker(): PlanModePhaseTracker {
  return {
    getPhase: () => "idle",
    clearSession: () => undefined
  } as unknown as PlanModePhaseTracker;
}

async function* stream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const message of messages) {
    yield message;
  }
}

const lifecycleMockStream: SDKMessage[] = [
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "he" }
    }
  } as unknown as SDKMessage,
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }]
    }
  } as SDKMessage,
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, output_tokens: 1 }
  } as unknown as SDKMessage
];

describe("agent-handlers events (get-events / lifecycle bus)", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    resetPlanningTodoStoreForTests();
    if (process.env.LUME_CONFIG_DIR) {
      rmSync(process.env.LUME_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  test("get-events returns empty events for an unknown thread", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-events-empty-"));
    const threadId = "thread-events-empty";

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const result = await handlers[AGENT_IPC_CHANNELS.GET_EVENTS]!({ threadId });
    expect(result).toEqual({ threadId, events: [] });
  });

  test("get-events reads persisted events and honors afterSeq", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-events-read-"));
    const threadId = "thread-events-read";

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const bus = getThreadEventBus(getRuntimeCoreSessionDir(threadId));
    for (let i = 1; i <= 3; i += 1) {
      await bus.publish(threadId, "run-1", {
        runId: "run-1",
        turnId: null,
        ts: i,
        kind: "run",
        phase: i === 1 ? "start" : i === 2 ? "update" : "end",
        detail: { type: "run.start" }
      });
    }

    const all = await handlers[AGENT_IPC_CHANNELS.GET_EVENTS]!({ threadId });
    expect((all as { events: Array<{ seq: number }> }).events.map((e) => e.seq)).toEqual([1, 2, 3]);

    const tail = await handlers[AGENT_IPC_CHANNELS.GET_EVENTS]!({ threadId, afterSeq: 2 });
    expect((tail as { events: Array<{ seq: number }> }).events.map((e) => e.seq)).toEqual([3]);
  });

  test("query stream projects the full lifecycle skeleton to the bus", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-events-on-"));
    const threadId = "thread-events-on";
    const sessionDir = getRuntimeCoreSessionDir(threadId);

    const result = await consumeRuntimeCoreQueryStream({
      query: stream(lifecycleMockStream),
      emit: { onSdkMessage: () => undefined },
      lifecycle: { threadId, sessionDir, runId: "lume-run-1" }
    });

    expect(result).toEqual({ status: "completed" });
    const envelopes = await getThreadEventBus(sessionDir).read(threadId);
    expect(envelopes.map((e) => `${e.kind}.${e.phase}`)).toEqual([
      "run.start",
      "turn.start",
      "message.start",
      "message.update",
      "message.end",
      "turn.end",
      "run.end"
    ]);
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(envelopes.map((e) => e.turnId)).toEqual([
      null,
      "turn-1",
      "turn-1",
      "turn-1",
      "turn-1",
      "turn-1",
      null
    ]);
    const runId = envelopes[0]!.runId;
    expect(runId).toBe("lume-run-1");
    for (const envelope of envelopes) {
      expect(envelope.threadId).toBe(threadId);
      expect(envelope.runId).toBe(runId);
    }
  });
});
