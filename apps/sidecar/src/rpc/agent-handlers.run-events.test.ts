import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanStateTracker } from "../services/agent/plan-state-tracker";
import { createFileBackedLumePlanStore } from "../services/agent-runtime/plan/plan-store";
import { getRuntimeCoreSessionDir } from "../services/pi-agent/runtime-core/session-store";

const appendedInputs: unknown[] = [];
const mockRunEvents: unknown[] = [
  { type: "assistant_delta", text: "hello" },
  {
    type: "run_completed",
    result: {
      status: "completed",
      finalOutput: "done"
    }
  }
];
mock.module("../services/agent/agent-service", () => ({
  appendAgentMessage: (input: unknown, emit: {
    onRunEvent?: (event: unknown) => void;
    onComplete: () => void;
  }, options?: { onExecutionStarted?: () => void }) => {
    appendedInputs.push(input);
    options?.onExecutionStarted?.();
    for (const event of mockRunEvents) {
      emit.onRunEvent?.(event);
    }
    emit.onComplete();
    return { ok: true, mode: "sent", queuedCount: 0 };
  },
  sendAgentMessage: async () => undefined,
  generateAgentTitle: async () => undefined,
  stopAgent: async () => undefined,
  submitAgentToolPermission: () => false,
  submitAskUserQuestionAnswers: () => false
}));

function createTestPlanStateTracker(): PlanStateTracker {
  return {
    isLikelyExecutionRequest: () => false,
    syncExecutionFromUserMessage: () => undefined,
    syncExecutionFromSendInput: () => undefined,
    getPhase: () => "idle",
    markCurrentStepCompleted: () => undefined,
    markCurrentStepFailed: () => undefined,
    clearSession: () => undefined
  } as unknown as PlanStateTracker;
}

describe("agent-handlers run events", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    appendedInputs.length = 0;
    mockRunEvents.splice(0, mockRunEvents.length,
      { type: "assistant_delta", text: "hello" },
      {
        type: "run_completed",
        result: {
          status: "completed",
          finalOutput: "done"
        }
      }
    );
    if (process.env.LUME_CONFIG_DIR) {
      rmSync(process.env.LUME_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  test("SEND_THREAD_MESSAGE maps continue into latest unfinished plan execution", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-continue-plan-rpc-"));
    const threadId = "thread-continue-plan";
    await createFileBackedLumePlanStore(getRuntimeCoreSessionDir(threadId)).upsert({
      id: "plan-1",
      runId: "run-1",
      threadId,
      goal: "Continue plan",
      summary: "Continue interrupted plan",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [
        {
          id: "step-1",
          title: "Done",
          description: "Done",
          type: "read",
          status: "completed"
        },
        {
          id: "step-2",
          title: "Patch",
          description: "Patch",
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
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planStateTracker: {
        ...createTestPlanStateTracker(),
        isLikelyExecutionRequest: () => true,
        syncExecutionFromSendInput: () => [{
          id: "step-1",
          text: "Patch",
          status: "in_progress",
          failCount: 0,
          lastError: null
        }],
        getPhase: () => "executing"
      } as unknown as PlanStateTracker,
      notifyPlanStateChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "继续"
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      permissionMode: "acceptEdits",
      messageMetadata: {
        hiddenFromChat: true,
        planControlEvent: "continue_plan_step",
        planExecutionKey: "plan-1",
        planExecutionMode: "step",
        planExecutionStepId: "step-2"
      }
    });
  });

  test("EXECUTE_PLAN starts latest approved structured plan through a plan control dispatch", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-execute-plan-rpc-"));
    const threadId = "thread-execute-plan";
    await createFileBackedLumePlanStore(getRuntimeCoreSessionDir(threadId)).upsert({
      id: "plan-1",
      runId: "run-1",
      threadId,
      goal: "Execute plan",
      summary: "Execute approved plan",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [
        {
          id: "step-1",
          title: "Patch",
          description: "Patch",
          type: "edit",
          status: "pending"
        }
      ],
      expectedChanges: {},
      status: "approved",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planStateTracker: {
        ...createTestPlanStateTracker(),
        isLikelyExecutionRequest: () => true,
        syncExecutionFromSendInput: () => [{
          id: "step-1",
          text: "Patch",
          status: "in_progress",
          failCount: 0,
          lastError: null
        }],
        getPhase: () => "executing"
      } as unknown as PlanStateTracker,
      notifyPlanStateChange: () => undefined
    });

    await expect(handlers[AGENT_IPC_CHANNELS.EXECUTE_PLAN]!({
      threadId,
      planId: "plan-1",
      intent: "execute"
    })).resolves.toMatchObject({
      ok: true,
      status: "sent",
      planId: "plan-1"
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      permissionMode: "acceptEdits",
      messageMetadata: {
        hiddenFromChat: true,
        planControlEvent: "execute_plan_step",
        planExecutionKey: "plan-1",
        planExecutionMode: "step",
        planExecutionStepId: "step-1"
      }
    });
    expect(notifications).toContainEqual({
      method: AGENT_IPC_CHANNELS.RUN_EVENT,
      params: {
        threadId,
        event: expect.objectContaining({
          type: "plan_progress",
          planId: "plan-1",
          status: "executing",
          currentStepId: "step-1"
        })
      }
    });
  });

  test("SUBMIT_PLAN_APPROVAL can approve and execute in one control flow", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-approve-execute-plan-rpc-"));
    const threadId = "thread-approve-execute-plan";
    await createFileBackedLumePlanStore(getRuntimeCoreSessionDir(threadId)).upsert({
      id: "plan-approval",
      runId: "run-1",
      threadId,
      goal: "Approve and execute",
      summary: "Approve and execute plan",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: "step-1",
        title: "Patch",
        description: "Patch",
        type: "edit",
        status: "pending"
      }],
      expectedChanges: {},
      status: "needs_approval",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    const { persistPlanApprovalInterruption } = await import("../services/agent-runtime/plan/plan-approval-service");
    await persistPlanApprovalInterruption({
      sessionDir: getRuntimeCoreSessionDir(threadId),
      plan: (await createFileBackedLumePlanStore(getRuntimeCoreSessionDir(threadId)).get("plan-approval"))!
    });
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planStateTracker: createTestPlanStateTracker(),
      notifyPlanStateChange: () => undefined
    });

    await expect(handlers[AGENT_IPC_CHANNELS.SUBMIT_PLAN_APPROVAL]!({
      threadId,
      planId: "plan-approval",
      decision: "approve",
      execute: true
    })).resolves.toMatchObject({
      ok: true,
      execution: {
        ok: true,
        status: "sent",
        planId: "plan-approval"
      }
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      messageMetadata: {
        hiddenFromChat: true,
        planControlEvent: "execute_plan_step",
        planExecutionKey: "plan-approval",
        planExecutionMode: "step",
        planExecutionStepId: "step-1"
      }
    });
  });

  test("SEND_THREAD_MESSAGE switches to planning when plan permission mode is selected", async () => {
    const planStateChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planStateTracker: createTestPlanStateTracker(),
      notifyPlanStateChange: (threadId, phase) => planStateChanges.push({ threadId, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId: "thread-1",
      userMessage: "帮我先做计划",
      permissionMode: "plan"
    });

    expect(planStateChanges).toContainEqual({
      threadId: "thread-1",
      phase: "planning"
    });
  });

  test("plain final output in planning mode is persisted as a fallback structured plan", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-fallback-plan-rpc-"));
    const threadId = "thread-fallback-plan";
    mockRunEvents.splice(0, mockRunEvents.length, {
      type: "run_completed",
      result: {
        status: "completed",
        finalOutput: [
          "# DeepSeek 开源计划调研方案",
          "",
          "1. 调研目标",
          "2. 调研范围"
        ].join("\n")
      }
    });
    const planStateChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const { listPendingPlanApprovalRequests } = await import("../services/agent-runtime/plan/plan-approval-service");
    const tracker = createTestPlanStateTracker();
    tracker.getPhase = () => "planning";
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planStateTracker: tracker,
      notifyPlanStateChange: (id, phase) => planStateChanges.push({ threadId: id, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "给我计划，不要执行",
      permissionMode: "plan"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const approvals = await listPendingPlanApprovalRequests(getRuntimeCoreSessionDir(threadId));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      threadId,
      stepCount: 2
    });
    expect(planStateChanges).toContainEqual({
      threadId,
      phase: "review"
    });
  });

  test("SEND_THREAD_MESSAGE forwards native structured run events without mapping raw SDK events", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planStateTracker: createTestPlanStateTracker(),
      notifyPlanStateChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId: "thread-1",
      userMessage: "hi"
    });

    expect(notifications.filter((item) => item.method === AGENT_IPC_CHANNELS.RUN_EVENT).map((item) => item.params)).toEqual([
      {
        threadId: "thread-1",
        event: { type: "assistant_delta", text: "hello" }
      },
      {
        threadId: "thread-1",
        event: {
          type: "run_completed",
          result: {
            status: "completed",
            finalOutput: "done"
          }
        }
      }
    ]);
  });
});
