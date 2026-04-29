import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumePlanStore } from "./plan-store";
import { createPlanWriteTool } from "./plan-write-tool";

describe("PlanWriteTool", () => {
  test("creates and updates structured plans with runtime linkage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-write-tool-"));
    const tool = createPlanWriteTool({
      sessionDir: dir,
      threadId: "thread-1",
      runId: "run-1",
      traceSpanId: "trace-span-1",
      now: () => "2026-04-29T00:00:00.000Z"
    });

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
        traceSpanId: "span-step-1"
      }]
    }, {} as any);

    expect(JSON.parse(String(created.content))).toEqual({
      planId: "plan-1",
      status: "needs_approval",
      stepCount: 1
    });

    const store = createFileBackedLumePlanStore(dir);
    expect(await store.get("plan-1")).toMatchObject({
      id: "plan-1",
      threadId: "thread-1",
      runId: "run-1",
      traceSpanId: "trace-span-1",
      steps: [{
        id: "step-1",
        traceSpanId: "span-step-1"
      }]
    });
  });
});
