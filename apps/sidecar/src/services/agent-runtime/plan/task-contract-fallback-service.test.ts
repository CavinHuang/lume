import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPendingTaskApprovalRequests } from "./task-approval-service";
import { persistFallbackTaskContractFromText } from "./task-contract-fallback-service";
import { createFileBackedTaskContractStore } from "./task-contract-store";

describe("task contract fallback service", () => {
  test("turns a plain planning response into an approvable task contract", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-task-contract-fallback-"));
    const updates: string[] = [];

    const contract = await persistFallbackTaskContractFromText({
      sessionDir,
      threadId: "thread-1",
      runId: "run-1",
      text: [
        "# DeepSeek 开源计划调研方案",
        "",
        "1. 调研目标",
        "2. 调研范围",
        "3. 数据收集策略"
      ].join("\n"),
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

    const stored = await createFileBackedTaskContractStore(sessionDir).get(contract!.id);
    expect(stored?.summary).toContain("DeepSeek 开源计划调研方案");

    const approvals = await listPendingTaskApprovalRequests(sessionDir);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      threadId: "thread-1",
      contractId: contract!.id,
      stepCount: 3
    });
  });
});
