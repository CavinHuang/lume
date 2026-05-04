import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPendingPlanApprovalRequests } from "./plan-approval-service";
import { persistFallbackPlanFromText } from "./plan-fallback-service";
import { createFileBackedLumePlanStore } from "./plan-store";

describe("plan fallback service", () => {
  test("turns a plain plan response into an approvable structured plan", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-plan-fallback-"));
    const updates: string[] = [];

    const plan = await persistFallbackPlanFromText({
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
      onPlanUpdated: (item) => {
        updates.push(item.id);
      }
    });

    expect(plan).not.toBeNull();
    expect(plan?.status).toBe("needs_approval");
    expect(plan?.steps.map((step) => step.title)).toEqual([
      "调研目标",
      "调研范围",
      "数据收集策略"
    ]);
    expect(updates).toEqual([plan!.id]);

    const stored = await createFileBackedLumePlanStore(sessionDir).get(plan!.id);
    expect(stored?.summary).toContain("DeepSeek 开源计划调研方案");

    const approvals = await listPendingPlanApprovalRequests(sessionDir);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      threadId: "thread-1",
      planId: plan!.id,
      stepCount: 3
    });
  });
});
