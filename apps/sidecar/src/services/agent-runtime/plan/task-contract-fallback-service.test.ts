import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPendingTaskApprovalRequests, resolveTaskApproval } from "./task-approval-service";
import { persistFallbackTaskContractFromText } from "./task-contract-fallback-service";
import { createFileBackedTaskContractStore } from "./task-contract-store";

describe("task contract fallback service", () => {
  test("turns a plain planning response into an approvable task contract", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-task-contract-fallback-"));
    const threadWorkspaceDir = mkdtempSync(join(tmpdir(), "lume-task-contract-fallback-thread-"));
    const updates: string[] = [];
    const text = [
      "# DeepSeek 开源计划调研方案",
      "",
      "1. 调研目标",
      "2. 调研范围",
      "3. 数据收集策略"
    ].join("\n");

    const contract = await persistFallbackTaskContractFromText({
      sessionDir,
      threadId: "thread-1",
      runId: "run-1",
      text,
      threadWorkspaceDir,
      now: () => "2026-05-01T00:00:00.000Z",
      onTaskContractUpdated: (item) => {
        updates.push(item.id);
      }
    });

    expect(contract).not.toBeNull();
    expect(contract?.status).toBe("needs_approval");
    expect(contract?.steps.map((step) => step.title)).toEqual([
      "调研目标",
      "调研范围",
      "数据收集策略"
    ]);
    expect(updates).toEqual([contract!.id]);

    const store = createFileBackedTaskContractStore(sessionDir);
    expect(await store.get(contract!.id)).toBeNull();
    expect(readFileSync(join(threadWorkspaceDir, "plans", `${contract!.id}.md`), "utf-8")).toBe(text);

    const approvals = await listPendingTaskApprovalRequests(sessionDir);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      threadId: "thread-1",
      contractId: contract!.id,
      planFilePath: `plans/${contract!.id}.md`,
      planVerified: true,
      stepCount: 3
    });

    expect(await resolveTaskApproval({
      sessionDir,
      threadId: "thread-1",
      contractId: contract!.id,
      decision: "approve"
    })).toBe(true);

    const stored = await store.get(contract!.id);
    expect(stored?.summary).toContain("DeepSeek 开源计划调研方案");
    expect(stored?.planFilePath).toBe(`plans/${contract!.id}.md`);
    expect(stored?.status).toBe("approved");
  });
});
