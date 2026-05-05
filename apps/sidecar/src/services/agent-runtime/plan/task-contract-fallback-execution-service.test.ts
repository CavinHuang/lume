import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedTaskContractStore } from "./task-contract-store";
import {
  markTaskContractFallbackExecutionFailed,
  markTaskContractFallbackExecutionWaiting,
  markTaskContractInteractionResolved
} from "./task-contract-fallback-execution-service";

describe("task-contract-fallback-execution-service", () => {
  test("marks a task contract failed for non-task-run fallbacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-execution-failed-"));
    const store = createFileBackedTaskContractStore(dir);
    await store.upsert(basePlan());

    await markTaskContractFallbackExecutionFailed({
      sessionDir: dir,
      threadId: "thread-1",
      error: "boom"
    });

    expect(await store.get("plan-1")).toMatchObject({
      status: "failed",
      currentStepId: "step-1",
      steps: [{ id: "step-1", status: "failed", error: "boom" }]
    });
  });

  test("marks task contract as waiting for interaction and returns it to executable state after resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-execution-waiting-"));
    const store = createFileBackedTaskContractStore(dir);
    await store.upsert({
      ...basePlan(),
      status: "executing",
      currentStepId: "step-1",
      steps: [{ ...basePlan().steps[0]!, status: "running" }]
    });

    await markTaskContractFallbackExecutionWaiting({
      sessionDir: dir,
      threadId: "thread-1",
      status: "needs_user_input",
      reason: "等待用户回答"
    });
    expect(await store.get("plan-1")).toMatchObject({
      status: "needs_user_input",
      currentStepId: "step-1",
      steps: [{ id: "step-1", status: "running", result: "等待用户回答" }]
    });

    await markTaskContractInteractionResolved({
      sessionDir: dir,
      threadId: "thread-1"
    });
    expect(await store.get("plan-1")).toMatchObject({
      status: "approved",
      currentStepId: "step-1"
    });
  });
});

function basePlan() {
  return {
    id: "plan-1",
    runId: "run-1",
    threadId: "thread-1",
    goal: "Ship runtime",
    summary: "Task contract fallback execution",
    assumptions: [],
    questions: [],
    risks: [],
    steps: [{
      id: "step-1",
      title: "Patch code",
      description: "Patch code",
      type: "edit" as const,
      status: "pending" as const
    }],
    expectedChanges: {},
    status: "approved" as const,
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z"
  };
}
