import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeInterruptionStore } from "../interruption/interruption-store";
import {
  listPendingTaskApprovalRequests,
  persistTaskApprovalInterruption,
  resolveTaskApproval
} from "./task-approval-service";
import { createFileBackedTaskContractStore } from "./task-contract-store";
import type { TaskContractRecord } from "./task-contract-record-types";

describe("task approval service", () => {
  test("persists task approval as an interruption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-approval-"));
    const plan: TaskContractRecord = {
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

    const interruption = await persistTaskApprovalInterruption({ sessionDir: dir, contract: plan });
    const stored = await createFileBackedLumeInterruptionStore(dir).get(interruption.id);

    expect(stored).toMatchObject({
      id: "task_approval:plan-1",
      runId: "run-1",
      threadId: "thread-1",
      type: "task_approval",
      status: "pending"
    });
  });

  test("lists plan approval drafts and creates the task contract only when approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-approval-"));
    const plan: TaskContractRecord = {
      id: "plan-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Ship task approval",
      summary: "Approve task contract",
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
      expectedChanges: { files: ["apps/web/src/components/agent/TaskProgressPanel.tsx"] },
      status: "needs_approval",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    };

    await persistTaskApprovalInterruption({ sessionDir: dir, contract: plan });
    expect(await createFileBackedTaskContractStore(dir).get("plan-1")).toBeNull();

    expect(await listPendingTaskApprovalRequests(dir)).toEqual([{
      threadId: "thread-1",
      runId: "run-1",
      requestId: "task_approval:plan-1",
      contractId: "plan-1",
      title: "审阅计划",
      message: "Approve task contract",
      summary: "Approve task contract",
      stepCount: 1,
      expectedChanges: { files: ["apps/web/src/components/agent/TaskProgressPanel.tsx"] }
    }]);

    expect(await resolveTaskApproval({
      sessionDir: dir,
      threadId: "thread-1",
      contractId: "plan-1",
      decision: "approve"
    })).toBe(true);

    const approvedPlan = await createFileBackedTaskContractStore(dir).get("plan-1");
    expect(approvedPlan).toMatchObject({
      status: "approved",
      approvedAt: expect.any(String)
    });
    expect(await listPendingTaskApprovalRequests(dir)).toEqual([]);
  });

  test("rejecting a plan approval draft does not create a task contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-reject-draft-"));
    const plan: TaskContractRecord = {
      id: "plan-reject",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Reject draft",
      summary: "Reject this plan",
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
      expectedChanges: {},
      status: "needs_approval",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    };

    await persistTaskApprovalInterruption({ sessionDir: dir, contract: plan });

    expect(await resolveTaskApproval({
      sessionDir: dir,
      threadId: "thread-1",
      contractId: "plan-reject",
      decision: "reject"
    })).toBe(true);

    expect(await createFileBackedTaskContractStore(dir).get("plan-reject")).toBeNull();
    expect(await listPendingTaskApprovalRequests(dir)).toEqual([]);
  });
});
