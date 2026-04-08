import { describe, expect, test } from "bun:test";
import type { AgentSendInput } from "@lume/shared";
import { PlanStateTracker } from "./plan-state-tracker";

function makeSendInput(userMessage: string, metadata?: Record<string, unknown>): AgentSendInput {
  return {
    threadId: "session-1",
    userMessage,
    permissionMode: "acceptEdits",
    ...(metadata ? { messageMetadata: metadata } : {})
  };
}

describe("plan-state-tracker", () => {
  test("应识别执行请求", () => {
    const tracker = new PlanStateTracker();
    expect(tracker.isLikelyExecutionRequest(makeSendInput("请开始执行计划第 1 步：实现接口"))).toBeTrue();
    expect(tracker.isLikelyExecutionRequest(makeSendInput("普通消息"))).toBeFalse();
    expect(tracker.isLikelyExecutionRequest(makeSendInput("普通消息", { planExecutionKey: "k1" }))).toBeTrue();
  });

  test("应从 tool_result 中解析 planPath", () => {
    const tracker = new PlanStateTracker();
    const payload = JSON.stringify({
      content: [
        { type: "text", text: JSON.stringify({ planPath: "/tmp/a/plans/p1.md" }) }
      ]
    });
    expect(tracker.parsePlanPathFromToolResult(payload)).toBe("/tmp/a/plans/p1.md");
  });

  test("应维护执行步骤并在完成后标记 completed", () => {
    const tracker = new PlanStateTracker();
    const threadId = "s-steps";

    const steps = tracker.syncExecutionFromUserMessage(threadId, "请开始执行计划第 1 步：初始化项目");
    expect(steps?.length).toBe(1);
    expect(steps?.[0]?.status).toBe("in_progress");

    const completed = tracker.markCurrentStepCompleted(threadId);
    expect(completed?.[0]?.status).toBe("completed");
  });

  test("应在失败时累计 failCount 并回填错误", () => {
    const tracker = new PlanStateTracker();
    const threadId = "s-fail";
    tracker.syncExecutionFromUserMessage(threadId, "请开始执行计划第 1 步：初始化项目");

    const failed = tracker.markCurrentStepFailed(threadId, "网络超时");
    expect(failed?.[0]?.status).toBe("failed");
    expect(failed?.[0]?.failCount).toBe(1);
    expect(failed?.[0]?.lastError).toBe("网络超时");
  });

  test("phase 未变化且无附加信息时不应重复发事件", () => {
    const tracker = new PlanStateTracker();
    const first = tracker.updatePhase("s-phase", "planning");
    const second = tracker.updatePhase("s-phase", "planning");
    expect(first?.phase).toBe("planning");
    expect(second).toBeNull();
  });
});

