import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeInterruptionStore } from "../interruption/interruption-store";
import {
  listPendingPlanApprovalRequests,
  persistPlanApprovalInterruption,
  resolvePlanApproval
} from "./plan-approval-service";
import { createFileBackedLumePlanStore } from "./plan-store";
import type { LumePlan } from "./plan-types";

describe("plan approval service", () => {
  test("persists plan approval as an interruption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-approval-"));
    const plan: LumePlan = {
      id: "plan-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Ship",
      summary: "Approve this plan",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [],
      expectedChanges: {},
      status: "needs_approval",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    };

    const interruption = await persistPlanApprovalInterruption({ sessionDir: dir, plan });
    const stored = await createFileBackedLumeInterruptionStore(dir).get(interruption.id);

    expect(stored).toMatchObject({
      id: "plan_approval:plan-1",
      runId: "run-1",
      threadId: "thread-1",
      type: "plan_approval",
      status: "pending"
    });
  });

  test("lists and resolves pending plan approvals while updating plan status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-approval-"));
    const plan: LumePlan = {
      id: "plan-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Ship plan approval",
      summary: "Approve structured plan",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: "step-1",
        title: "Implement",
        description: "Implement",
        type: "edit",
        status: "pending"
      }],
      expectedChanges: { files: ["apps/web/src/components/agent/PlanPanel.tsx"] },
      status: "needs_approval",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    };

    await createFileBackedLumePlanStore(dir).upsert(plan);
    await persistPlanApprovalInterruption({ sessionDir: dir, plan });

    expect(await listPendingPlanApprovalRequests(dir)).toEqual([{
      threadId: "thread-1",
      runId: "run-1",
      requestId: "plan_approval:plan-1",
      planId: "plan-1",
      title: "确认执行计划",
      message: "Approve structured plan",
      summary: "Approve structured plan",
      stepCount: 1,
      expectedChanges: { files: ["apps/web/src/components/agent/PlanPanel.tsx"] }
    }]);

    expect(await resolvePlanApproval({
      sessionDir: dir,
      threadId: "thread-1",
      planId: "plan-1",
      decision: "approve"
    })).toBe(true);

    const approvedPlan = await createFileBackedLumePlanStore(dir).get("plan-1");
    expect(approvedPlan).toMatchObject({
      status: "approved",
      approvedAt: expect.any(String)
    });
    expect(await listPendingPlanApprovalRequests(dir)).toEqual([]);
  });
});
