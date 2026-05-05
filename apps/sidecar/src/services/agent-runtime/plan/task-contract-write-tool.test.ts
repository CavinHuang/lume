import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPendingTaskApprovalRequests } from "./task-approval-service";
import { createFileBackedTaskContractStore } from "./task-contract-store";
import { createTaskContractWriteTool } from "./task-contract-write-tool";

describe("TaskContractWriteTool", () => {
  test("creates and updates task contracts with runtime linkage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-"));
    const tool = createTaskContractWriteTool({
      sessionDir: dir,
      threadId: "thread-1",
      runId: "run-1",
      traceSpanId: "trace-span-1",
      now: () => "2026-04-29T00:00:00.000Z"
    });
    expect(tool.isReadOnly?.()).toBeTrue();

    const created = await tool.call({
      id: "plan-1",
      goal: "Ship runtime",
      summary: "Add structured runtime plan",
      status: "needs_approval",
      steps: [{
        id: "step-1",
        title: "Inspect",
        description: "Read runtime files",
        type: "read",
        status: "completed",
        result: "already done",
        error: "should not persist",
        traceSpanId: "span-step-1"
      }]
    }, {} as any);

    expect(JSON.parse(String(created.content))).toEqual({
      contractId: "plan-1",
      status: "needs_approval",
      stepCount: 1
    });

    const store = createFileBackedTaskContractStore(dir);
    const saved = await store.get("plan-1");
    expect(saved).toMatchObject({
      id: "plan-1",
      threadId: "thread-1",
      runId: "run-1",
      traceSpanId: "trace-span-1",
      steps: [{
        id: "step-1",
        status: "pending"
      }]
    });
    expect(saved?.currentStepId).toBeUndefined();
    expect(await listPendingTaskApprovalRequests(dir)).toMatchObject([{
      threadId: "thread-1",
      runId: "run-1",
      contractId: "plan-1",
      title: "确认任务清单",
      message: "Add structured runtime plan",
      stepCount: 1
    }]);
  });

  test("accepts common step shapes from model output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-shapes-"));
    const tool = createTaskContractWriteTool({
      sessionDir: dir,
      threadId: "thread-1",
      runId: "run-1",
      now: () => "2026-04-29T00:00:00.000Z"
    });

    const created = await tool.call({
      id: "plan-1",
      goal: "Ship runtime",
      summary: "Accept model step shapes",
      status: "needs_approval",
      steps: [
        "Inspect code",
        { id: "step-2", text: "Patch code", type: "edit" }
      ]
    }, {} as any);

    expect(JSON.parse(String(created.content))).toMatchObject({
      contractId: "plan-1",
      status: "needs_approval",
      stepCount: 2
    });
    expect(await createFileBackedTaskContractStore(dir).get("plan-1")).toMatchObject({
      steps: [
        { id: "step-1", title: "Inspect code", status: "pending" },
        { id: "step-2", title: "Patch code", type: "edit", status: "pending" }
      ]
    });
  });
});
