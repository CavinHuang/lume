import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeInterruptionStore } from "../interruption/interruption-store";
import { persistPlanApprovalInterruption } from "./plan-approval-service";
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
});
