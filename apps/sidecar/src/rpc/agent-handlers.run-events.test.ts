import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import type { TaskContractRecord } from "../services/agent-runtime/plan/task-contract-record-types";
import { createFileBackedTaskContractStore } from "../services/agent-runtime/plan/task-contract-store";
import { createFileBackedTaskRunStore } from "../services/agent-runtime/task-run/task-run-store";
import { getRuntimeCoreSessionDir } from "../services/agent-runtime/runtime-core/session-store";

const appendedInputs: unknown[] = [];
let mockCompletePayload: { reason?: "max_turns" } | undefined;
const mockRuntimeEvents: unknown[] = [
  {
    id: "runtime-1",
    type: "assistant.delta",
    threadId: "thread-1",
    runId: "run-1",
    createdAt: "2026-05-11T00:00:00.000Z",
    delta: "hello"
  },
  {
    id: "runtime-2",
    type: "run.completed",
    threadId: "thread-1",
    runId: "run-1",
    createdAt: "2026-05-11T00:00:01.000Z",
    finalOutput: "done"
  }
];
mock.module("../services/agent/agent-service", () => ({
  appendAgentMessage: (input: unknown, emit: {
    onRuntimeEvent?: (event: unknown) => void;
    onComplete: (payload?: { reason?: "max_turns" }) => void;
  }, options?: { onExecutionStarted?: () => void }) => {
    appendedInputs.push(input);
    options?.onExecutionStarted?.();
    for (const event of mockRuntimeEvents) {
      emit.onRuntimeEvent?.({
        ...(event as Record<string, unknown>),
        threadId: (input as { threadId?: string }).threadId ?? "thread-1"
      });
    }
    emit.onComplete(mockCompletePayload);
    return { ok: true, mode: "sent", queuedCount: 0 };
  },
  sendAgentMessage: async () => undefined,
  generateAgentTitle: async () => undefined,
  stopAgent: async () => undefined,
  submitAgentToolPermission: () => false,
  submitAskUserQuestionAnswers: () => false
}));

function createTestPlanModePhaseTracker(): PlanModePhaseTracker {
  return {
    isLikelyExecutionRequest: () => false,
    getPhase: () => "idle",
    clearSession: () => undefined
  } as unknown as PlanModePhaseTracker;
}

describe("agent-handlers run events", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    appendedInputs.length = 0;
    mockCompletePayload = undefined;
    mockRuntimeEvents.splice(0, mockRuntimeEvents.length,
      {
        id: "runtime-1",
        type: "assistant.delta",
        threadId: "thread-1",
        runId: "run-1",
        createdAt: "2026-05-11T00:00:00.000Z",
        delta: "hello"
      },
      {
        id: "runtime-2",
        type: "run.completed",
        threadId: "thread-1",
        runId: "run-1",
        createdAt: "2026-05-11T00:00:01.000Z",
        finalOutput: "done"
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

  test("SEND_THREAD_MESSAGE maps explicit implementation approval into latest unfinished task execution", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-continue-plan-rpc-"));
    const threadId = "thread-continue-plan";
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    await createFileBackedTaskContractStore(sessionDir).upsert({
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
          status: "pending"
        },
        {
          id: "step-2",
          title: "Patch",
          description: "Patch",
          type: "edit",
          status: "pending"
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
      status: "approved",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    await createFileBackedTaskRunStore(sessionDir).upsert({
      id: "taskrun-plan-1",
      contractId: "plan-1",
      runId: "run-1",
      threadId,
      goal: "Continue plan",
      summary: "Continue interrupted plan",
      status: "failed",
      currentTaskId: "step-2",
      tasks: [
        {
          id: "step-1",
          title: "Done",
          description: "Done",
          status: "completed",
          attemptCount: 1
        },
        {
          id: "step-2",
          title: "Patch",
          description: "Patch",
          status: "failed",
          attemptCount: 1,
          error: "boom"
        },
        {
          id: "step-3",
          title: "Verify",
          description: "Verify",
          status: "pending",
          attemptCount: 0
        }
      ],
      events: [{
        type: "task_failed",
        taskRunId: "taskrun-plan-1",
        contractId: "plan-1",
        taskId: "step-2",
        message: "boom",
        createdAt: "2026-05-01T00:00:01.000Z"
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:01.000Z"
    });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planModePhaseTracker: {
        ...createTestPlanModePhaseTracker(),
        isLikelyExecutionRequest: () => true,
        getPhase: () => "executing"
      } as unknown as PlanModePhaseTracker,
      notifyPlanModePhaseChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "继续实现"
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      permissionMode: "acceptEdits",
      messageMetadata: {
        hiddenFromChat: true,
        taskControlEvent: "continue_task",
        taskRunId: "taskrun-plan-1",
        taskId: "step-2"
      }
    });
  });

  test("SEND_THREAD_MESSAGE approval text in plan permission mode dispatches execution with edit permission", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-approve-from-plan-mode-rpc-"));
    const threadId = "thread-approve-from-plan-mode";
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    await createFileBackedTaskContractStore(sessionDir).upsert({
      id: "plan-from-plan-mode",
      runId: "run-1",
      threadId,
      goal: "Execute approved plan",
      summary: "Execute from plan permission mode",
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
      status: "approved",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: {
        ...createTestPlanModePhaseTracker(),
        isLikelyExecutionRequest: () => true,
        getPhase: () => "awaiting_approval"
      } as unknown as PlanModePhaseTracker,
      notifyPlanModePhaseChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "继续执行",
      permissionMode: "plan"
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      permissionMode: "acceptEdits",
      messageMetadata: {
        taskRunId: "taskrun-plan-from-plan-mode",
        taskId: "step-1"
      }
    });
  });

  test("SEND_THREAD_MESSAGE approval text approves a pending plan and starts execution", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-natural-approve-plan-rpc-"));
    const { persistTaskApprovalInterruption, listPendingTaskApprovalRequests } = await import("../services/agent-runtime/plan/task-approval-service");
    const { createAgentHandlers } = await import("./agent-handlers");
    const approvalTexts = ["继续执行", "approve", "按这个做"];

    for (const [index, userMessage] of approvalTexts.entries()) {
      appendedInputs.length = 0;
      const threadId = `thread-natural-approve-plan-${index}`;
      const sessionDir = getRuntimeCoreSessionDir(threadId);
      const contractId = `plan-natural-approval-${index}`;
      const contract: TaskContractRecord = {
        id: contractId,
        runId: "run-1",
        threadId,
        goal: "Natural approval",
        summary: "Approve from chat input",
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
      };
      const store = createFileBackedTaskContractStore(sessionDir);
      await store.upsert(contract);
      await persistTaskApprovalInterruption({ sessionDir, contract });
      const handlers = createAgentHandlers({
        writeNotification: () => undefined,
        planModePhaseTracker: {
          ...createTestPlanModePhaseTracker(),
          isLikelyExecutionRequest: () => true,
          getPhase: () => "awaiting_approval"
        } as unknown as PlanModePhaseTracker,
        notifyPlanModePhaseChange: () => undefined
      });

      await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
        threadId,
        userMessage,
        permissionMode: "plan"
      });

      expect(await store.get(contractId)).toMatchObject({
        status: "approved"
      });
      expect(await listPendingTaskApprovalRequests(sessionDir)).toEqual([]);
      expect(appendedInputs[0]).toMatchObject({
        threadId,
        permissionMode: "acceptEdits",
        messageMetadata: {
          taskControlEvent: "execute_task",
          taskRunId: `taskrun-${contractId}`,
          taskId: "step-1"
        }
      });
    }
  });

  test("SEND_THREAD_MESSAGE keeps ordinary plan feedback in plan mode instead of executing", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-plan-feedback-rpc-"));
    const threadId = "thread-plan-feedback";
    await createFileBackedTaskContractStore(getRuntimeCoreSessionDir(threadId)).upsert({
      id: "plan-1",
      runId: "run-1",
      threadId,
      goal: "Revise plan",
      summary: "Revise approved plan",
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
      status: "approved",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    const phaseChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: (threadId, phase) => phaseChanges.push({ threadId, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "风险写清楚",
      permissionMode: "plan"
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      userMessage: "风险写清楚",
      permissionMode: "plan"
    });
    expect(JSON.stringify(appendedInputs[0])).not.toContain("taskControlEvent");
    expect(phaseChanges).toContainEqual({ threadId, phase: "planning" });
  });

  test("SEND_THREAD_MESSAGE turns ordinary feedback on a pending plan into replanning input", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-pending-plan-feedback-rpc-"));
    const threadId = "thread-pending-plan-feedback";
    await createFileBackedTaskContractStore(getRuntimeCoreSessionDir(threadId)).upsert({
      id: "plan-feedback-chat",
      runId: "run-1",
      threadId,
      goal: "Revise pending plan",
      summary: "Pending plan needs feedback",
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
    const { persistTaskApprovalInterruption, listPendingTaskApprovalRequests } = await import("../services/agent-runtime/plan/task-approval-service");
    await persistTaskApprovalInterruption({
      sessionDir: getRuntimeCoreSessionDir(threadId),
      contract: (await createFileBackedTaskContractStore(getRuntimeCoreSessionDir(threadId)).get("plan-feedback-chat"))!
    });
    const phaseChanges: Array<{ threadId: string; phase: string }> = [];
    const tracker = createTestPlanModePhaseTracker();
    tracker.getPhase = () => "awaiting_approval";
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: tracker,
      notifyPlanModePhaseChange: (threadId, phase) => phaseChanges.push({ threadId, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "风险写清楚",
      permissionMode: "plan"
    });

    expect(await listPendingTaskApprovalRequests(getRuntimeCoreSessionDir(threadId))).toEqual([]);
    expect(appendedInputs[0]).toMatchObject({
      threadId,
      permissionMode: "plan",
      messageMetadata: {
        taskApprovalRejected: {
          contractId: "plan-feedback-chat"
        }
      }
    });
    expect(JSON.stringify(appendedInputs[0])).toContain("风险写清楚");
    expect(JSON.stringify(appendedInputs[0])).toContain("plan-feedback-chat");
    expect(phaseChanges).toContainEqual({ threadId, phase: "planning" });
  });

  test("EXECUTE_TASK_CONTRACT starts latest approved task contract through a task control dispatch", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-execute-plan-rpc-"));
    const threadId = "thread-execute-plan";
    await createFileBackedTaskContractStore(getRuntimeCoreSessionDir(threadId)).upsert({
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
      planModePhaseTracker: {
        ...createTestPlanModePhaseTracker(),
        isLikelyExecutionRequest: () => true,
        getPhase: () => "executing"
      } as unknown as PlanModePhaseTracker,
      notifyPlanModePhaseChange: () => undefined
    });

    await expect(handlers[AGENT_IPC_CHANNELS.EXECUTE_TASK_CONTRACT]!({
      threadId,
      contractId: "plan-1",
      intent: "execute"
    })).resolves.toMatchObject({
      ok: true,
      status: "sent",
      contractId: "plan-1"
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      permissionMode: "acceptEdits",
      messageMetadata: {
        hiddenFromChat: true,
        taskControlEvent: "execute_task",
        taskRunId: "taskrun-plan-1",
        taskId: "step-1"
      }
    });
    expect(notifications).toContainEqual({
      method: AGENT_IPC_CHANNELS.RUNTIME_EVENT,
      params: {
        threadId,
        event: expect.objectContaining({
          type: "task.progress",
          taskRunId: "taskrun-plan-1",
          status: "running",
          currentTaskId: "step-1"
        })
      }
    });
  });

  test("max-turn task completion keeps the current task running for continuation", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-max-turn-task-rpc-"));
    mockCompletePayload = { reason: "max_turns" };
    const threadId = "thread-max-turn-task";
    await createFileBackedTaskContractStore(getRuntimeCoreSessionDir(threadId)).upsert({
      id: "plan-max-turn",
      runId: "run-1",
      threadId,
      goal: "Continue after max turns",
      summary: "Keep task resumable",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: "step-1",
        title: "Long task",
        description: "Long task",
        type: "edit",
        status: "pending"
      }],
      expectedChanges: {},
      status: "approved",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createFileBackedTaskRunStore } = await import("../services/agent-runtime/task-run/task-run-store");
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planModePhaseTracker: {
        ...createTestPlanModePhaseTracker(),
        getPhase: () => "executing"
      } as unknown as PlanModePhaseTracker,
      notifyPlanModePhaseChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.EXECUTE_TASK_CONTRACT]!({
      threadId,
      contractId: "plan-max-turn"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const taskRun = await createFileBackedTaskRunStore(getRuntimeCoreSessionDir(threadId)).get("taskrun-plan-max-turn");
    expect(taskRun).toMatchObject({
      status: "running",
      currentTaskId: "step-1",
      tasks: [{ id: "step-1", status: "running" }]
    });
    expect(taskRun?.events.map((event) => event.type)).not.toContain("task_failed");
    expect(notifications.some((item) => (
      item.method === AGENT_IPC_CHANNELS.RUNTIME_EVENT
      && (item.params as { event?: { type?: string; status?: string } }).event?.type === "task.progress"
      && (item.params as { event?: { status?: string } }).event?.status === "running"
    ))).toBeTrue();
  });

  test("SUBMIT_TASK_APPROVAL can approve and execute in one control flow", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-approve-execute-plan-rpc-"));
    const threadId = "thread-approve-execute-plan";
    const planApprovalDraft: TaskContractRecord = {
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
    };
    const store = createFileBackedTaskContractStore(getRuntimeCoreSessionDir(threadId));
    await store.upsert(planApprovalDraft);
    const { persistTaskApprovalInterruption } = await import("../services/agent-runtime/plan/task-approval-service");
    await persistTaskApprovalInterruption({
      sessionDir: getRuntimeCoreSessionDir(threadId),
      contract: planApprovalDraft
    });
    expect(await store.get("plan-approval")).toMatchObject({ status: "needs_approval" });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    await expect(handlers[AGENT_IPC_CHANNELS.SUBMIT_TASK_APPROVAL]!({
      threadId,
      contractId: "plan-approval",
      decision: "approve",
      execute: true
    })).resolves.toMatchObject({
      ok: true,
      execution: {
        ok: true,
        status: "sent",
        contractId: "plan-approval"
      }
    });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      messageMetadata: {
        hiddenFromChat: true,
        taskControlEvent: "execute_task",
        taskRunId: "taskrun-plan-approval",
        taskId: "step-1"
      }
    });
    expect(notifications).toContainEqual({
      method: AGENT_IPC_CHANNELS.RUNTIME_EVENT,
      params: {
        threadId,
        event: expect.objectContaining({
          type: "task.progress",
          taskRunId: "taskrun-plan-approval",
          contractId: "plan-approval",
          status: "running",
          currentTaskId: "step-1"
        })
      }
    });
  });

  test("SUBMIT_TASK_APPROVAL rejection with feedback sends the agent back to plan mode", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-reject-feedback-plan-rpc-"));
    const threadId = "thread-reject-feedback-plan";
    await createFileBackedTaskContractStore(getRuntimeCoreSessionDir(threadId)).upsert({
      id: "plan-feedback",
      runId: "run-1",
      threadId,
      goal: "Revise plan",
      summary: "Initial plan",
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
    const { persistTaskApprovalInterruption } = await import("../services/agent-runtime/plan/task-approval-service");
    await persistTaskApprovalInterruption({
      sessionDir: getRuntimeCoreSessionDir(threadId),
      contract: (await createFileBackedTaskContractStore(getRuntimeCoreSessionDir(threadId)).get("plan-feedback"))!
    });
    const phaseChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: (id, phase) => phaseChanges.push({ threadId: id, phase })
    });

    await expect(handlers[AGENT_IPC_CHANNELS.SUBMIT_TASK_APPROVAL]!({
      threadId,
      contractId: "plan-feedback",
      decision: "reject",
      feedback: "请把风险和文件列表写清楚"
    })).resolves.toEqual({ ok: true, feedback: "请把风险和文件列表写清楚", replanning: { status: "sent" } });

    expect(appendedInputs[0]).toMatchObject({
      threadId,
      permissionMode: "plan",
      messageMetadata: {
        taskApprovalRejected: {
          contractId: "plan-feedback"
        }
      }
    });
    expect(JSON.stringify(appendedInputs[0])).toContain("请把风险和文件列表写清楚");
    expect(phaseChanges).toContainEqual({ threadId, phase: "planning" });
  });

  test("SEND_THREAD_MESSAGE switches to planning when plan permission mode is selected", async () => {
    const planModePhaseChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: (threadId, phase) => planModePhaseChanges.push({ threadId, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId: "thread-1",
      userMessage: "帮我先做计划",
      permissionMode: "plan"
    });

    expect(planModePhaseChanges).toContainEqual({
      threadId: "thread-1",
      phase: "planning"
    });
  });

  test("plain final output in planning mode does not synthesize a fallback task contract", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-no-fallback-plan-rpc-"));
    const threadId = "thread-no-fallback-plan";
    mockRuntimeEvents.splice(0, mockRuntimeEvents.length, {
      id: "runtime-plan-completed",
      type: "run.completed",
      threadId,
      runId: "run-1",
      createdAt: "2026-05-11T00:00:00.000Z",
      finalOutput: [
        "# DeepSeek 开源计划调研方案",
        "",
        "1. 调研目标",
        "2. 调研范围"
      ].join("\n")
    });
    const planModePhaseChanges: Array<{ threadId: string; phase: string }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const { listPendingTaskApprovalRequests } = await import("../services/agent-runtime/plan/task-approval-service");
    const tracker = createTestPlanModePhaseTracker();
    tracker.getPhase = () => "planning";
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: tracker,
      notifyPlanModePhaseChange: (id, phase) => planModePhaseChanges.push({ threadId: id, phase })
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId,
      userMessage: "给我计划，不要执行",
      permissionMode: "plan"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await listPendingTaskApprovalRequests(getRuntimeCoreSessionDir(threadId))).toEqual([]);
    expect(planModePhaseChanges).toContainEqual({
      threadId,
      phase: "planning"
    });
    expect(planModePhaseChanges).not.toContainEqual({
      threadId,
      phase: "awaiting_approval"
    });
  });

  test("SEND_THREAD_MESSAGE forwards native structured run events without mapping raw SDK events", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: (method, params) => notifications.push({ method, params }),
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId: "thread-1",
      userMessage: "hi"
    });

    expect(notifications.filter((item) => item.method === AGENT_IPC_CHANNELS.RUNTIME_EVENT).map((item) => item.params)).toEqual([
      {
        threadId: "thread-1",
        event: {
          id: "runtime-1",
          type: "assistant.delta",
          threadId: "thread-1",
          runId: "run-1",
          createdAt: "2026-05-11T00:00:00.000Z",
          delta: "hello"
        }
      },
      {
        threadId: "thread-1",
        event: {
          id: "runtime-2",
          type: "run.completed",
          threadId: "thread-1",
          runId: "run-1",
          createdAt: "2026-05-11T00:00:01.000Z",
          finalOutput: "done"
        }
      }
    ]);
    expect(notifications).toContainEqual({
      method: "agent:runtime-event",
      params: {
        threadId: "thread-1",
        event: {
          id: "runtime-1",
          type: "assistant.delta",
          threadId: "thread-1",
          runId: "run-1",
          createdAt: "2026-05-11T00:00:00.000Z",
          delta: "hello"
        }
      }
    });
  });
});
