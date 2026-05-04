import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumePlanStore } from "./plan-store";
import {
  buildCurrentPlanStepSendInput,
  markCurrentPlanStepUnreported,
  startNextPlanStep,
  skipCurrentPlanStep
} from "./plan-execution-controller";

describe("plan-execution-controller", () => {
  test("starts only the next executable step and builds a current-step control input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-controller-"));
    const store = createFileBackedLumePlanStore(dir);
    await store.upsert({
      id: "plan-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Ship runtime",
      summary: "Execute step-by-step",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [
        {
          id: "step-1",
          title: "Patch code",
          description: "Patch code",
          type: "edit",
          status: "pending"
        },
        {
          id: "step-2",
          title: "Verify",
          description: "Verify",
          type: "execute",
          status: "pending"
        }
      ],
      expectedChanges: {},
      status: "approved",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });

    const started = await startNextPlanStep({
      sessionDir: dir,
      threadId: "thread-1",
      planId: "plan-1",
      now: () => "2026-05-01T00:01:00.000Z"
    });

    expect(started?.step.id).toBe("step-1");
    expect(await store.get("plan-1")).toMatchObject({
      status: "executing",
      currentStepId: "step-1",
      steps: [
        {
          id: "step-1",
          status: "running",
          attemptCount: 1,
          startedAt: "2026-05-01T00:01:00.000Z"
        },
        { id: "step-2", status: "pending" }
      ],
      events: [
        { type: "plan_started", planId: "plan-1" },
        { type: "step_started", planId: "plan-1", stepId: "step-1" }
      ]
    });

    expect(buildCurrentPlanStepSendInput({
      threadId: "thread-1",
      plan: started!.plan,
      step: started!.step
    })).toMatchObject({
      threadId: "thread-1",
      permissionMode: "acceptEdits",
      messageMetadata: {
        hiddenFromChat: true,
        planControlEvent: "execute_plan_step",
        planExecutionKey: "plan-1",
        planExecutionMode: "step",
        planExecutionStepId: "step-1"
      }
    });
  });

  test("marks running step failed when a run ends without structured reporting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-controller-unreported-"));
    const store = createFileBackedLumePlanStore(dir);
    await store.upsert({
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
        title: "Patch code",
        description: "Patch code",
        type: "edit",
        status: "running"
      }],
      expectedChanges: {},
      status: "executing",
      currentStepId: "step-1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });

    await markCurrentPlanStepUnreported({
      sessionDir: dir,
      threadId: "thread-1",
      now: () => "2026-05-01T00:02:00.000Z"
    });

    expect(await store.get("plan-1")).toMatchObject({
      status: "failed",
      currentStepId: "step-1",
      steps: [{
        id: "step-1",
        status: "failed",
        error: "步骤未提交结构化结果",
        endedAt: "2026-05-01T00:02:00.000Z"
      }],
      events: [{
        type: "step_failed",
        planId: "plan-1",
        stepId: "step-1",
        message: "步骤未提交结构化结果"
      }]
    });
  });

  test("skips the current failed step and records a plan event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-controller-skip-"));
    const store = createFileBackedLumePlanStore(dir);
    await store.upsert({
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
        title: "Patch code",
        description: "Patch code",
        type: "edit",
        status: "failed",
        error: "boom"
      }],
      expectedChanges: {},
      status: "failed",
      currentStepId: "step-1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });

    await skipCurrentPlanStep({
      sessionDir: dir,
      threadId: "thread-1",
      now: () => "2026-05-01T00:03:00.000Z"
    });

    const saved = await store.get("plan-1");
    expect(saved).toMatchObject({
      status: "completed",
      steps: [{ id: "step-1", status: "skipped" }],
      events: [
        {
          type: "step_skipped",
          planId: "plan-1",
          stepId: "step-1",
          message: "已跳过计划步骤"
        },
        { type: "plan_completed", planId: "plan-1" }
      ]
    });
    expect(saved).not.toHaveProperty("currentStepId");
  });
});
