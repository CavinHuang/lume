import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumePlanStore } from "./plan-store";
import { createPlanStepUpdateTool } from "./plan-step-update-tool";

describe("PlanStepUpdateTool", () => {
  test("completes only the current running step and records a plan event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-step-update-"));
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
          status: "running"
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
      status: "executing",
      currentStepId: "step-1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });

    const tool = createPlanStepUpdateTool({
      sessionDir: dir,
      threadId: "thread-1",
      now: () => "2026-05-01T00:01:00.000Z"
    });

    const result = await tool.call({
      planId: "plan-1",
      stepId: "step-1",
      status: "completed",
      result: "Patched runtime"
    }, {} as any);

    expect(JSON.parse(String(result.content))).toEqual({
      ok: true,
      planId: "plan-1",
      stepId: "step-1",
      status: "completed"
    });
    const saved = await store.get("plan-1");
    expect(saved).toMatchObject({
      status: "approved",
      steps: [
        {
          id: "step-1",
          status: "completed",
          result: "Patched runtime",
          endedAt: "2026-05-01T00:01:00.000Z"
        },
        { id: "step-2", status: "pending" }
      ],
      events: [
        {
          type: "step_completed",
          planId: "plan-1",
          stepId: "step-1",
          message: "Patched runtime",
          createdAt: "2026-05-01T00:01:00.000Z"
        }
      ]
    });
    expect(saved).not.toHaveProperty("currentStepId");
  });

  test("rejects attempts to complete a non-current step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-step-update-reject-"));
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
          status: "running"
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
      status: "executing",
      currentStepId: "step-1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });

    const tool = createPlanStepUpdateTool({
      sessionDir: dir,
      threadId: "thread-1"
    });

    const result = await tool.call({
      planId: "plan-1",
      stepId: "step-2",
      status: "completed",
      result: "Verified"
    }, {} as any);
    expect(result).toMatchObject({
      is_error: true,
      content: "Error: 只能更新当前正在执行的计划步骤"
    });
    expect(await store.get("plan-1")).toMatchObject({
      currentStepId: "step-1",
      steps: [
        { id: "step-1", status: "running" },
        { id: "step-2", status: "pending" }
      ]
    });
  });
});
