import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumePlanStore } from "./plan-store";
import {
  importMarkdownPlan,
  mapMarkdownPlanToLumePlan,
  mapPlanStateStepsToLumePlan
} from "./plan-file-mapper";

describe("plan-file-mapper", () => {
  test("maps existing markdown plan front matter and task list into LumePlan", () => {
    const plan = mapMarkdownPlanToLumePlan({
      runId: "run-1",
      threadId: "thread-1",
      path: "/tmp/plans/demo.md",
      content: [
        "---",
        "summary: \"演示计划\"",
        "slug: demo-plan",
        "status: approved",
        "---",
        "# Ship runtime",
        "",
        "- [x] Read current runtime",
        "- [ ] Extract runner loop",
        "- [ ] Verify tests"
      ].join("\n"),
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    expect(plan.id).toBe("demo-plan");
    expect(plan.goal).toBe("Ship runtime");
    expect(plan.summary).toBe("演示计划");
    expect(plan.status).toBe("approved");
    expect(plan.steps.map((step) => [step.title, step.status])).toEqual([
      ["Read current runtime", "completed"],
      ["Extract runner loop", "pending"],
      ["Verify tests", "pending"]
    ]);
    expect(plan.expectedChanges.files).toEqual(["/tmp/plans/demo.md"]);
  });

  test("imports mapped markdown plan into store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-import-"));
    try {
      const store = createFileBackedLumePlanStore(dir);
      const plan = await importMarkdownPlan(store, {
        runId: "run-1",
        threadId: "thread-1",
        content: "# Plan\n\n1. Inspect\n2. Implement"
      });

      const listed = await store.listByThread("thread-1");
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(plan.id);
      expect(listed[0]?.steps.map((step) => step.title)).toEqual(["Inspect", "Implement"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maps PlanStateTracker execution steps into LumePlan", () => {
    const plan = mapPlanStateStepsToLumePlan({
      runId: "run-1",
      threadId: "thread-1",
      goal: "Execute approved plan",
      planPath: "/tmp/plans/demo.md",
      steps: [
        { id: "step-a", text: "Read files", status: "completed", failCount: 0, lastError: null },
        { id: "step-b", text: "Implement changes", status: "in_progress", failCount: 0, lastError: null },
        { id: "step-c", text: "Run tests", status: "failed", failCount: 1, lastError: "boom" }
      ],
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    expect(plan.status).toBe("failed");
    expect(plan.steps.map((step) => [step.id, step.status, step.error])).toEqual([
      ["step-a", "completed", undefined],
      ["step-b", "running", undefined],
      ["step-c", "failed", "boom"]
    ]);
  });
});
