import { describe, expect, test } from "bun:test";
import { PlanModePhaseTracker } from "./plan-mode-phase-tracker";

describe("plan-mode-phase-tracker", () => {
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
