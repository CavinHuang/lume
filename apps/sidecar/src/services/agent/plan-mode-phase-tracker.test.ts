import { describe, expect, test } from "bun:test";
import type { AgentSendInput } from "@lume/shared";
import { PlanModePhaseTracker } from "./plan-mode-phase-tracker";

function makeSendInput(userMessage: string, metadata?: Record<string, unknown>): AgentSendInput {
  return {
    threadId: "session-1",
    userMessage,
    permissionMode: "acceptEdits",
    ...(metadata ? { messageMetadata: metadata } : {})
  };
}

describe("plan-mode-phase-tracker", () => {
  test("应识别执行请求", () => {
    const tracker = new PlanModePhaseTracker();
    expect(tracker.isLikelyExecutionRequest(makeSendInput("执行当前任务", {
      taskRunId: "taskrun-1",
      taskId: "task-1"
    }))).toBeTrue();
    expect(tracker.isLikelyExecutionRequest(makeSendInput("普通消息"))).toBeFalse();
  });

  test("phase 未变化且无附加信息时不应重复发事件", () => {
    const tracker = new PlanModePhaseTracker();
    const first = tracker.updatePhase("s-phase", "planning");
    const second = tracker.updatePhase("s-phase", "planning");
    expect(first?.phase).toBe("planning");
    expect(second).toBeNull();
  });

  test("awaiting_approval 即使 phase 未变化也应发事件以刷新待审批计划", () => {
    const tracker = new PlanModePhaseTracker();
    const first = tracker.updatePhase("s-phase", "awaiting_approval");
    const second = tracker.updatePhase("s-phase", "awaiting_approval");
    expect(first?.phase).toBe("awaiting_approval");
    expect(second).toEqual({
      threadId: "s-phase",
      phase: "awaiting_approval"
    });
  });
});
