import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPendingTaskApprovalRequests, resolveTaskApproval } from "./task-approval-service";
import { createFileBackedTaskContractStore } from "./task-contract-store";
import { createTaskContractWriteTool } from "./task-contract-write-tool";

describe("TaskContractWriteTool", () => {
  test("writes a reviewable plan first and creates the task contract only after approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-"));
    const threadWorkspaceDir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-thread-"));
    const tool = createTaskContractWriteTool({
      sessionDir: dir,
      threadId: "thread-1",
      runId: "run-1",
      threadWorkspaceDir,
      traceSpanId: "trace-span-1",
      now: () => "2026-04-29T00:00:00.000Z"
    });
    expect(tool.isReadOnly?.()).toBeTrue();

    const created = await tool.call({
      id: "plan-1",
      goal: "Ship runtime",
      summary: "Add structured runtime plan",
      status: "needs_approval",
      planMarkdown: "# Ship runtime\n\n## Steps\n1. Read runtime files",
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
      stepCount: 1,
      planFilePath: "plans/plan-1.md",
      planVerified: true
    });

    const store = createFileBackedTaskContractStore(dir);
    expect(await store.get("plan-1")).toBeNull();
    expect(await listPendingTaskApprovalRequests(dir)).toMatchObject([{
      threadId: "thread-1",
      runId: "run-1",
      contractId: "plan-1",
      title: "审阅计划",
      message: "Add structured runtime plan",
      planFilePath: "plans/plan-1.md",
      planVerified: true,
      stepCount: 1
    }]);

    expect(await resolveTaskApproval({
      sessionDir: dir,
      threadId: "thread-1",
      contractId: "plan-1",
      decision: "approve"
    })).toBe(true);

    const saved = await store.get("plan-1");
    expect(saved).toMatchObject({
      id: "plan-1",
      threadId: "thread-1",
      runId: "run-1",
      traceSpanId: "trace-span-1",
      status: "approved",
      planFilePath: "plans/plan-1.md",
      planVerification: {
        verified: true,
        planFilePath: "plans/plan-1.md",
        checkedAt: "2026-04-29T00:00:00.000Z"
      },
      steps: [{
        id: "step-1",
        status: "pending"
      }]
    });
    expect(saved?.currentStepId).toBeUndefined();
  });

  test("refuses approval when no markdown plan file was generated and verified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-missing-plan-"));
    const threadWorkspaceDir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-thread-"));
    const tool = createTaskContractWriteTool({
      sessionDir: dir,
      threadId: "thread-1",
      runId: "run-1",
      threadWorkspaceDir
    });

    const result = await tool.call({
      id: "plan-1",
      goal: "Ship runtime",
      summary: "Missing markdown plan",
      status: "needs_approval",
      steps: ["Inspect code"]
    }, {} as any);

    expect(result).toMatchObject({
      is_error: true,
      content: "Error: 提交审批前必须生成并验证 Markdown 计划文件"
    });
    expect(await createFileBackedTaskContractStore(dir).get("plan-1")).toBeNull();
    expect(await listPendingTaskApprovalRequests(dir)).toEqual([]);
  });

  test("rejects planFilePath values outside the thread workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-plan-path-"));
    const tool = createTaskContractWriteTool({
      sessionDir: dir,
      threadId: "thread-1",
      runId: "run-1"
    });

    const result = await tool.call({
      id: "plan-1",
      goal: "Ship runtime",
      summary: "Reject bad plan path",
      status: "needs_approval",
      planFilePath: "../plan.md",
      steps: ["Inspect code"]
    }, {} as any);

    expect(result).toMatchObject({
      is_error: true,
      content: "Error: planFilePath 必须是线程工作区内的相对路径"
    });
    expect(await createFileBackedTaskContractStore(dir).get("plan-1")).toBeNull();
  });

  test("writes markdown plans into the thread workspace before requesting approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-plan-md-"));
    const threadWorkspaceDir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-thread-"));
    const tool = createTaskContractWriteTool({
      sessionDir: dir,
      threadId: "thread-1",
      runId: "run-1",
      threadWorkspaceDir
    });

    const result = await tool.call({
      id: "plan-1",
      goal: "Ship runtime",
      summary: "Write a readable plan",
      status: "needs_approval",
      planMarkdown: "# Ship runtime\n\n## Steps\n1. Inspect code",
      steps: ["Inspect code"]
    }, {} as any);

    expect(JSON.parse(String(result.content))).toMatchObject({
      contractId: "plan-1",
      status: "needs_approval",
      stepCount: 1,
      planFilePath: "plans/plan-1.md",
      planVerified: true
    });
    expect(readFileSync(join(threadWorkspaceDir, "plans", "plan-1.md"), "utf-8")).toBe("# Ship runtime\n\n## Steps\n1. Inspect code");
    expect(await createFileBackedTaskContractStore(dir).get("plan-1")).toBeNull();
    expect(await listPendingTaskApprovalRequests(dir)).toMatchObject([{
      contractId: "plan-1",
      planFilePath: "plans/plan-1.md"
    }]);
    expect(existsSync(join(threadWorkspaceDir, "..", "plan-1.md"))).toBeFalse();
  });

  test("accepts common step shapes from model output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-shapes-"));
    const threadWorkspaceDir = mkdtempSync(join(tmpdir(), "lume-task-contract-write-tool-shapes-thread-"));
    const tool = createTaskContractWriteTool({
      sessionDir: dir,
      threadId: "thread-1",
      runId: "run-1",
      threadWorkspaceDir,
      now: () => "2026-04-29T00:00:00.000Z"
    });

    const created = await tool.call({
      id: "plan-1",
      goal: "Ship runtime",
      summary: "Accept model step shapes",
      status: "needs_approval",
      planMarkdown: "# Ship runtime\n\n## Steps\n1. Inspect code\n2. Patch code",
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
    expect(await createFileBackedTaskContractStore(dir).get("plan-1")).toBeNull();
    expect(await listPendingTaskApprovalRequests(dir)).toMatchObject([{
      contractId: "plan-1",
      stepCount: 2
    }]);
  });
});
