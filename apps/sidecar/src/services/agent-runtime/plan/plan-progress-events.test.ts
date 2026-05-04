import { describe, expect, test } from "bun:test";
import { projectPlanToProgressEvents } from "./plan-progress-events";
import type { LumePlan } from "./plan-types";

describe("plan-progress-events", () => {
  test("projects plan lifecycle events into stable plan_progress run events", () => {
    const plan: LumePlan = {
      id: "plan-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Ship runtime",
      summary: "Execute step-by-step",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: "step-1",
        title: "Patch",
        description: "Patch",
        type: "edit",
        status: "completed",
        result: "Patched"
      }],
      expectedChanges: {},
      status: "completed",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:02:00.000Z",
      events: [
        { type: "step_started", planId: "plan-1", stepId: "step-1", createdAt: "2026-05-01T00:01:00.000Z" },
        { type: "step_completed", planId: "plan-1", stepId: "step-1", message: "Patched", createdAt: "2026-05-01T00:02:00.000Z" }
      ]
    };

    expect(projectPlanToProgressEvents(plan)).toEqual([
      {
        type: "plan_progress",
        planId: "plan-1",
        status: "completed",
        currentStepId: undefined,
        steps: plan.steps,
        message: "Patch",
        createdAt: "2026-05-01T00:01:00.000Z"
      },
      {
        type: "plan_progress",
        planId: "plan-1",
        status: "completed",
        currentStepId: undefined,
        steps: plan.steps,
        message: "Patched",
        createdAt: "2026-05-01T00:02:00.000Z"
      }
    ]);
  });
});
