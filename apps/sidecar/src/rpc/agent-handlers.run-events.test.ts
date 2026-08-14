import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { resetPlanningTodoStoreForTests } from "../services/planning/planning-todo-store";

const appendedInputs: unknown[] = [];
let mockCompletePayload: { reason?: "max_turns" } | undefined;
const mockRuntimeEvents: unknown[] = [
  {
    id: "runtime-1",
    type: "assistant.delta",
    threadId: "thread-1",
    runId: "run-1",
    createdAt: "2026-05-11T00:00:00.000Z",
    delta: "hello"
  },
  {
    id: "runtime-2",
    type: "run.completed",
    threadId: "thread-1",
    runId: "run-1",
    createdAt: "2026-05-11T00:00:01.000Z",
    finalOutput: "done"
  }
];
mock.module("../services/agent/agent-service", () => ({
  appendAgentMessage: (input: unknown, emit: {
    onRuntimeEvent?: (event: unknown) => void;
    onComplete: (payload?: { reason?: "max_turns" }) => void;
  }, options?: { onExecutionStarted?: () => void }) => {
    appendedInputs.push(input);
    options?.onExecutionStarted?.();
    for (const event of mockRuntimeEvents) {
      emit.onRuntimeEvent?.({
        threadId: (input as { threadId?: string }).threadId ?? "thread-1",
        ...(event as Record<string, unknown>)
      });
    }
    emit.onComplete(mockCompletePayload);
    return { ok: true, mode: "sent", queuedCount: 0 };
  },
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
  submitAskUserQuestionAnswers: () => false,
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

describe("agent-handlers run events", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    resetPlanningTodoStoreForTests();
    appendedInputs.length = 0;
    mockCompletePayload = undefined;
    mockRuntimeEvents.splice(0, mockRuntimeEvents.length,
      {
        id: "runtime-1",
        type: "assistant.delta",
        threadId: "thread-1",
        runId: "run-1",
        createdAt: "2026-05-11T00:00:00.000Z",
        delta: "hello"
      },
      {
        id: "runtime-2",
        type: "run.completed",
        threadId: "thread-1",
        runId: "run-1",
        createdAt: "2026-05-11T00:00:01.000Z",
        finalOutput: "done"
      }
    );
    if (process.env.LUME_CONFIG_DIR) {
      rmSync(process.env.LUME_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  test("SEND_THREAD_MESSAGE keeps ordinary plan feedback in plan mode instead of executing", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-plan-feedback-rpc-"));
    const threadId = "thread-plan-feedback";
    const phaseChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: (threadId, phase) => phaseChanges.push({ threadId, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "风险写清楚",
      permissionMode: "plan"
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      userMessage: "风险写清楚",
      permissionMode: "plan"
    });
    expect(JSON.stringify(appendedInputs[0])).not.toContain("taskControlEvent");
    expect(phaseChanges).toContainEqual({ threadId, phase: "planning" });
  });

  test("SEND_THREAD_MESSAGE switches to planning when plan permission mode is selected", async () => {
    const planModePhaseChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: (threadId, phase) => planModePhaseChanges.push({ threadId, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId: "thread-1",
      userMessage: "帮我先做计划",
      permissionMode: "plan"
    });

    expect(planModePhaseChanges).toContainEqual({
      threadId: "thread-1",
      phase: "planning"
    });
  });

  test("plain final output in planning mode does not synthesize a fallback task contract", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-no-fallback-plan-rpc-"));
    const threadId = "thread-no-fallback-plan";
    mockRuntimeEvents.splice(0, mockRuntimeEvents.length, {
      id: "runtime-plan-completed",
      type: "run.completed",
      threadId,
      runId: "run-1",
      createdAt: "2026-05-11T00:00:00.000Z",
      finalOutput: [
        "# DeepSeek 开源计划调研方案",
        "",
        "1. 调研目标",
        "2. 调研范围"
      ].join("\n")
    });
    const planModePhaseChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const tracker = createTestPlanModePhaseTracker();
    tracker.getPhase = () => "planning";
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: tracker,
      notifyPlanModePhaseChange: (id, phase) => planModePhaseChanges.push({ threadId: id, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "给我计划，不要执行",
      permissionMode: "plan"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(planModePhaseChanges).toContainEqual({
      threadId,
      phase: "planning"
    });
    expect(planModePhaseChanges).not.toContainEqual({
      threadId,
      phase: "awaiting_approval"
    });
  });

  test("SEND_THREAD_MESSAGE forwards native structured run events without mapping raw SDK events", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId: "thread-1",
      userMessage: "hi"
    });

    expect(notifications.filter((item) => item.method === AGENT_IPC_CHANNELS.RUNTIME_EVENT).map((item) => item.params)).toEqual([
      {
        threadId: "thread-1",
        event: {
          id: "runtime-1",
          type: "assistant.delta",
          threadId: "thread-1",
          runId: "run-1",
          createdAt: "2026-05-11T00:00:00.000Z",
          delta: "hello"
        }
      },
      {
        threadId: "thread-1",
        event: {
          id: "runtime-2",
          type: "run.completed",
          threadId: "thread-1",
          runId: "run-1",
          createdAt: "2026-05-11T00:00:01.000Z",
          finalOutput: "done"
        }
      }
    ]);
    expect(notifications).toContainEqual({
      method: "agent:runtime-event",
      params: {
        threadId: "thread-1",
        event: {
          id: "runtime-1",
          type: "assistant.delta",
          threadId: "thread-1",
          runId: "run-1",
          createdAt: "2026-05-11T00:00:00.000Z",
          delta: "hello"
        }
      }
    });
  });

  test("routes child runtime notifications by the event thread instead of the parent emitter", async () => {
    mockRuntimeEvents.splice(0, mockRuntimeEvents.length, {
      id: "child-runtime-1",
      type: "assistant.delta",
      threadId: "child-thread",
      runId: "child-attempt-1",
      createdAt: "2026-05-11T00:00:00.000Z",
      delta: "child output"
    });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({ threadId: "parent-thread", userMessage: "hi" });

    expect(notifications).toContainEqual({
      method: AGENT_IPC_CHANNELS.RUNTIME_EVENT,
      params: {
        threadId: "child-thread",
        event: expect.objectContaining({ threadId: "child-thread", runId: "child-attempt-1" })
      }
    });
  });
});
