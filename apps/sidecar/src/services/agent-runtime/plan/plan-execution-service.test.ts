import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumePlanStore } from "./plan-store";
import {
  buildPlanExecutionSendInput,
  buildPlanContinuationSendInput,
  markStructuredPlanExecutionCompleted,
  markStructuredPlanExecutionFailed,
  markStructuredPlanExecutionWaiting,
  markStructuredPlanInteractionResolved,
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

  test("can complete every remaining step for a full-plan execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-execution-all-"));
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
          status: "running"
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
      status: "executing",
      currentStepId: "step-1",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    await markStructuredPlanExecutionCompleted({
      sessionDir: dir,
      threadId: "thread-1",
      completeAll: true,
      result: "final output"
    });

    const plan = await store.get("plan-1");
    expect(plan).toMatchObject({
      status: "completed",
      steps: [
        { id: "step-1", status: "completed", result: "final output" },
        { id: "step-2", status: "completed", result: "final output" }
      ]
    });
    expect(plan).not.toHaveProperty("currentStepId");
  });

  test("builds a send input for continuing an interrupted plan", () => {
    expect(buildPlanContinuationSendInput({
      threadId: "thread-1",
      userMessage: "继续",
      plan: {
        id: "plan-1",
        runId: "run-1",
        threadId: "thread-1",
        goal: "Ship runtime",
        summary: "Continue structured plan",
        assumptions: [],
        questions: [],
        risks: [],
        steps: [
          {
            id: "step-1",
            title: "Read code",
            description: "Read code",
            type: "read",
            status: "completed"
          },
          {
            id: "step-2",
            title: "Patch code",
            description: "Patch code",
            type: "edit",
            status: "failed",
            error: "boom"
          },
          {
            id: "step-3",
            title: "Verify",
            description: "Verify",
            type: "execute",
            status: "pending"
          }
        ],
        expectedChanges: {},
        status: "failed",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z"
      }
    })).toMatchObject({
      threadId: "thread-1",
      userMessage: [
        "请按顺序自动继续执行当前未完成计划。",
        "计划摘要：Continue structured plan",
        "执行步骤：\n1. Patch code\n2. Verify",
        "执行过程中请按计划逐项推进；遇到阻塞再询问我。"
      ].join("\n\n"),
      permissionMode: "acceptEdits",
      messageMetadata: {
        hiddenFromChat: true,
        planControlEvent: "continue_plan",
        planExecutionKey: "plan-1",
        planExecutionMode: "all",
        planExecutionSteps: ["Patch code", "Verify"]
      }
    });
  });

  test("marks plan as waiting for interaction and returns it to executable state after resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-plan-execution-waiting-"));
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
      steps: [{
        id: "step-1",
        title: "Patch code",
        description: "Patch code",
        type: "edit",
        status: "running"
      }],
      expectedChanges: {},
      status: "executing",
      currentStepId: "step-1",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    await markStructuredPlanExecutionWaiting({
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

    await markStructuredPlanInteractionResolved({
      sessionDir: dir,
      threadId: "thread-1"
    });
    expect(await store.get("plan-1")).toMatchObject({
      status: "approved",
      currentStepId: "step-1"
    });
  });

  test("builds a continuation input for a resolved interrupted plan", () => {
    expect(buildPlanContinuationSendInput({
      threadId: "thread-1",
      userMessage: "继续",
      plan: {
        id: "plan-1",
        runId: "run-1",
        threadId: "thread-1",
        goal: "Ship runtime",
        summary: "Continue resolved plan",
        assumptions: [],
        questions: [],
        risks: [],
        steps: [{
          id: "step-1",
          title: "Patch code",
          description: "Patch code",
          type: "edit",
          status: "running"
        }],
        expectedChanges: {},
        status: "approved",
        currentStepId: "step-1",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z"
      }
    })).toMatchObject({
      messageMetadata: {
        planExecutionSteps: ["Patch code"]
      }
    });
  });

  test("builds a hidden control send input for executing an approved plan", () => {
    expect(buildPlanExecutionSendInput({
      threadId: "thread-1",
      plan: {
        id: "plan-1",
        runId: "run-1",
        threadId: "thread-1",
        goal: "Ship runtime",
        summary: "Execute structured plan",
        assumptions: [],
        questions: [],
        risks: [],
        steps: [{
          id: "step-1",
          title: "Patch code",
          description: "Patch code",
          type: "edit",
          status: "pending"
        }],
        expectedChanges: {},
        status: "approved",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z"
      }
    })).toMatchObject({
      threadId: "thread-1",
      userMessage: [
        "请按顺序自动执行已批准计划的全部剩余任务。",
        "计划摘要：Execute structured plan",
        "执行步骤：\n1. Patch code",
        "执行过程中请按计划逐项推进；遇到阻塞再询问我。"
      ].join("\n\n"),
      permissionMode: "acceptEdits",
      messageMetadata: {
        hiddenFromChat: true,
        planControlEvent: "execute_plan",
        planExecutionKey: "plan-1",
        planExecutionMode: "all",
        planExecutionSteps: ["Patch code"]
      }
    });
  });

  test("does not build a continuation input for a completed plan", () => {
    expect(buildPlanContinuationSendInput({
      threadId: "thread-1",
      userMessage: "继续",
      plan: {
        id: "plan-1",
        runId: "run-1",
        threadId: "thread-1",
        goal: "Ship runtime",
        summary: "Completed plan",
        assumptions: [],
        questions: [],
        risks: [],
        steps: [{
          id: "step-1",
          title: "Done",
          description: "Done",
          type: "read",
          status: "completed"
        }],
        expectedChanges: {},
        status: "completed",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z"
      }
    })).toBeNull();
  });
});
