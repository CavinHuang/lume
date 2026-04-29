import { describe, expect, mock, test } from "bun:test";
import { AGENT_IPC_CHANNELS, type SDKMessage } from "@lume/shared";
import type { PlanStateTracker } from "../services/agent/plan-state-tracker";

mock.module("../services/agent/agent-service", () => ({
  appendAgentMessage: async (_input: unknown, emit: {
    onSdkMessage: (message: SDKMessage) => void;
    onComplete: () => void;
  }) => {
    emit.onSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }]
      }
    } as SDKMessage);
    emit.onSdkMessage({
      type: "result",
      subtype: "success",
      result: "done"
    } as SDKMessage);
    emit.onComplete();
    return { queued: false };
  },
  sendAgentMessage: async () => undefined,
  generateAgentTitle: async () => undefined,
  stopAgent: async () => undefined,
  submitAgentToolPermission: () => false,
  submitAskUserQuestionAnswers: () => false
}));

function createTestPlanStateTracker(): PlanStateTracker {
  return {
    isLikelyExecutionRequest: () => false,
    syncExecutionFromUserMessage: () => undefined,
    getPhase: () => "idle",
    markCurrentStepCompleted: () => undefined,
    markCurrentStepFailed: () => undefined,
    clearSession: () => undefined
  } as unknown as PlanStateTracker;
}

describe("agent-handlers run events", () => {
  test("SEND_THREAD_MESSAGE emits structured run events alongside raw SDK stream events", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planStateTracker: createTestPlanStateTracker(),
      notifyPlanStateChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId: "thread-1",
      userMessage: "hi"
    });

    expect(notifications.filter((item) => item.method === AGENT_IPC_CHANNELS.STREAM_EVENT)).toHaveLength(2);
    expect(notifications.filter((item) => item.method === AGENT_IPC_CHANNELS.RUN_EVENT).map((item) => item.params)).toEqual([
      {
        threadId: "thread-1",
        event: { type: "assistant_delta", text: "hello" }
      },
      {
        threadId: "thread-1",
        event: {
          type: "run_completed",
          result: {
            status: "completed",
            finalOutput: "done"
          }
        }
      },
      {
        threadId: "thread-1",
        event: {
          type: "run_completed",
          result: { status: "completed" }
        }
      }
    ]);
  });
});
