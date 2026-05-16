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
      status: "pending",
      payload: {
        contractId: "plan-1"
      }
    });
    expect(stored?.message).toBe("审阅任务计划");
  });

  test("does not list approval requests without a stored task contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-approval-missing-contract-"));
    await persistTaskApprovalInterruption({
      sessionDir: dir,
      contract: {
        id: "plan-missing",
        runId: "run-1",
        threadId: "thread-1",
        goal: "Ship",
        summary: "Missing from store",
        assumptions: [],
        questions: [],
        risks: [],
        steps: [],
        expectedChanges: {},
        status: "needs_approval",
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z"
      }
    });

    expect(await listPendingTaskApprovalRequests(dir)).toEqual([]);
  });

  test("lists stored plan approval drafts and approves the task contract", async () => {
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

    const store = createFileBackedTaskContractStore(dir);
    await store.upsert(plan);
    await persistTaskApprovalInterruption({ sessionDir: dir, contract: plan });
    expect(await store.get("plan-1")).toMatchObject({ status: "needs_approval" });

    expect(await listPendingTaskApprovalRequests(dir)).toEqual([{
      threadId: "thread-1",
      runId: "run-1",
      requestId: "task_approval:plan-1",
      contractId: "plan-1",
      title: "审阅计划",
      message: "审阅任务计划",
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

    const approvedPlan = await store.get("plan-1");
    expect(approvedPlan).toMatchObject({
      status: "approved",
      approvedAt: expect.any(String)
    });
    expect(await listPendingTaskApprovalRequests(dir)).toEqual([]);
  });

  test("rejecting a plan approval draft marks the stored task contract cancelled", async () => {
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

    const store = createFileBackedTaskContractStore(dir);
    await store.upsert(plan);
    await persistTaskApprovalInterruption({ sessionDir: dir, contract: plan });

    expect(await resolveTaskApproval({
      sessionDir: dir,
      threadId: "thread-1",
      contractId: "plan-reject",
      decision: "reject"
    })).toBe(true);

    expect(await store.get("plan-reject")).toMatchObject({ status: "cancelled" });
    expect(await listPendingTaskApprovalRequests(dir)).toEqual([]);
  });
});
