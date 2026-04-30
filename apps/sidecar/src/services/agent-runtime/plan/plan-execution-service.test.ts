import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumePlanStore } from "./plan-store";
import {
  markStructuredPlanExecutionCompleted,
  markStructuredPlanExecutionFailed,
  markStructuredPlanExecutionStarted
} from "./plan-execution-service";

describe("plan-execution-service", () => {
  test("updates structured plan step lifecycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-execution-"));
    const store = createFileBackedLumePlanStore(dir);
    await store.upsert({
      id: "plan-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Ship runtime",
      summary: "Structured plan execution",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [
        {
          id: "step-1",
          title: "Read code",
          description: "Read code",
          type: "read",
          status: "pending"
        },
        {
          id: "step-2",
          title: "Edit code",
          description: "Edit code",
          type: "edit",
          status: "pending"
        }
      ],
      expectedChanges: {},
      status: "approved",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    await markStructuredPlanExecutionStarted({
      sessionDir: dir,
      threadId: "thread-1",
      stepText: "Read runtime code"
    });
    expect(await store.get("plan-1")).toMatchObject({
      status: "executing",
      currentStepId: "step-1",
      steps: [
        { id: "step-1", title: "Read runtime code", status: "running" },
        { id: "step-2", status: "pending" }
      ]
    });

    await markStructuredPlanExecutionCompleted({ sessionDir: dir, threadId: "thread-1" });
    expect(await store.get("plan-1")).toMatchObject({
      status: "approved",
      steps: [
        { id: "step-1", status: "completed" },
        { id: "step-2", status: "pending" }
      ]
    });

    await markStructuredPlanExecutionStarted({ sessionDir: dir, threadId: "thread-1" });
    await markStructuredPlanExecutionFailed({
      sessionDir: dir,
      threadId: "thread-1",
      error: "boom"
    });
    expect(await store.get("plan-1")).toMatchObject({
      status: "failed",
      currentStepId: "step-2",
      steps: [
        { id: "step-1", status: "completed" },
        { id: "step-2", status: "failed", error: "boom" }
      ]
    });
  });
});
