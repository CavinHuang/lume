import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { AgentTaskContractsResult } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { persistTaskApprovalInterruption } from "../services/agent-runtime/plan/task-approval-service";
import { createFileBackedTaskContractStore } from "../services/agent-runtime/plan/task-contract-store";
import { createFileBackedRunContinuationStore } from "../services/agent-runtime/runner/run-continuation-store";
import { createFileBackedLumeRunStateStore } from "../services/agent-runtime/runner/run-state-store";
import { createFileBackedTaskRunStore } from "../services/agent-runtime/task-run/task-run-store";
import { createFileBackedLumeTraceStore } from "../services/agent-runtime/trace/trace-store";
import { getRuntimeCoreSessionDir } from "../services/pi-agent/runtime-core/session-store";

const sendAgentMessageMock = mock(async (_input: unknown, emit?: {
  onMessageAppended?: (event: { threadId: string; message: { role: "assistant"; content: string } }) => void;
  onComplete?: () => void;
}, _options?: unknown) => {
  emit?.onMessageAppended?.({
    threadId: "thread-runtime-state",
    message: {
      role: "assistant",
      content: "resumed output"
    }
  });
  emit?.onComplete?.();
});

mock.module("../services/agent/agent-service", () => ({
  appendAgentMessage: async () => ({ queued: false }),
  sendAgentMessage: sendAgentMessageMock,
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

describe("agent-handlers runtime state", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    if (process.env.LUME_CONFIG_DIR) {
      rmSync(process.env.LUME_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  test("exposes resume, run summaries, redacted trace, and task contracts through IPC handlers", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-state-rpc-"));
    const threadId = "thread-runtime-state";
    const runId = "run-1";
    const traceId = "trace-1";
    const sessionDir = getRuntimeCoreSessionDir(threadId);

    const runStore = createFileBackedLumeRunStateStore(sessionDir);
    await runStore.create({
      version: 1,
      runId,
      threadId,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "paused",
      input: { userMessage: "resume me" },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId,
      model: { provider: "openai", modelId: "gpt-test" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });
    await runStore.appendItem(runId, {
      type: "assistant_message",
      id: "assistant-1",
      content: [{ type: "text", text: "historical answer" }],
      createdAt: "2026-04-30T00:00:01.000Z"
    });

    await createFileBackedRunContinuationStore(sessionDir).upsert({
      version: 1,
      runId,
      threadId,
      status: "ready_to_resume",
      checkpoint: {
        step: "waiting_for_tool_result",
        toolCallId: "tool-1",
        toolName: "Read",
        toolKind: "read"
      },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    const traceStore = createFileBackedLumeTraceStore(sessionDir);
    await traceStore.create({
      id: traceId,
      threadId,
      runId,
      name: "Runtime trace",
      status: "completed",
      startedAt: "2026-04-30T00:00:00.000Z",
      spans: [{
        id: "span-1",
        traceId,
        type: "tool_call",
        name: "Bash",
        status: "completed",
        startedAt: "2026-04-30T00:00:00.000Z",
        input: { command: "echo OPENAI_API_KEY=sk-secret-token" },
        output: "done"
      }]
    });

    await createFileBackedTaskContractStore(sessionDir).upsert({
      id: "plan-1",
      runId,
      threadId,
      goal: "Finish runtime state",
      summary: "Expose task contracts",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: "step-1",
        title: "Read plan",
        description: "Read plan",
        type: "read",
        status: "completed"
      }],
      expectedChanges: {},
      status: "approved",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });
    await createFileBackedTaskRunStore(sessionDir).upsert({
      id: "taskrun-1",
      contractId: "plan-1",
      runId,
      threadId,
      goal: "Finish runtime state",
      summary: "Expose task progress",
      status: "running",
      currentTaskId: "step-1",
      tasks: [{
        id: "step-1",
        title: "Read plan",
        description: "Read plan",
        status: "running",
        attemptCount: 1
      }],
      events: [{
        type: "task_started",
        taskRunId: "taskrun-1",
        taskId: "step-1",
        createdAt: "2026-04-30T00:00:02.000Z"
      }],
      createdAt: "2026-04-30T00:00:02.000Z",
      updatedAt: "2026-04-30T00:00:02.000Z"
    });
    const planNeedingApproval = {
      id: "plan-needs-approval",
      runId,
      threadId,
      goal: "Approve runtime plan",
      summary: "Needs approval",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [],
      expectedChanges: {},
      status: "needs_approval" as const,
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    };
    await createFileBackedTaskContractStore(sessionDir).upsert(planNeedingApproval);
    await persistTaskApprovalInterruption({ sessionDir, contract: planNeedingApproval });

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const resume = await handlers[AGENT_IPC_CHANNELS.RESUME_RUN]!({ threadId, runId });
    expect(resume).toMatchObject({
      status: "waiting_for_approval"
    });

    const runs = await handlers[AGENT_IPC_CHANNELS.LIST_RUN_STATES]!({ threadId });
    expect(runs).toMatchObject({
      runs: [{
        runId,
        threadId,
        status: "waiting_for_approval",
        traceId,
        model: { provider: "openai", modelId: "gpt-test" },
        pendingInterruptionCount: 1,
        generatedItemCount: 1,
        continuation: {
          status: "ready_to_resume",
          checkpoint: {
            step: "waiting_for_tool_result",
            toolCallId: "tool-1",
            toolName: "Read",
            toolKind: "read"
          }
        }
      }]
    });

    const runtimeEvents = await handlers[AGENT_IPC_CHANNELS.GET_THREAD_RUNTIME_EVENTS]!({ threadId });
    expect(runtimeEvents).toMatchObject({
      threadId,
      events: [
        { type: "run.started", threadId, runId },
        { type: "message.user.submitted", text: "resume me", threadId, runId },
        { type: "assistant.delta", delta: "historical answer", threadId, runId },
        { type: "task.progress", taskRunId: "taskrun-1", threadId, runId }
      ]
    });

    const trace = await handlers[AGENT_IPC_CHANNELS.GET_RUN_TRACE]!({ threadId, runId });
    expect(JSON.stringify(trace)).not.toContain("sk-secret-token");
    expect(trace).toMatchObject({
      trace: {
        id: traceId,
        spans: [{
          input: "[REDACTED_PAYLOAD]",
          output: "[REDACTED_PAYLOAD]"
        }]
      }
    });

    const contracts = await handlers[AGENT_IPC_CHANNELS.LIST_TASK_CONTRACTS]!({ threadId }) as AgentTaskContractsResult;
    expect(contracts.contracts).toContainEqual(expect.objectContaining({
        id: "plan-1",
        goal: "Finish runtime state",
        steps: [expect.objectContaining({ id: "step-1", status: "completed" })]
    }));

    const pending = await handlers[AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE]!({ threadId });
    expect(pending).toMatchObject([{
      threadId,
      taskApprovals: [{
        contractId: "plan-needs-approval",
        requestId: "task_approval:plan-needs-approval",
        message: "Needs approval"
      }]
    }]);

    expect(await handlers[AGENT_IPC_CHANNELS.SUBMIT_TASK_APPROVAL]!({
      threadId,
      contractId: "plan-needs-approval",
      decision: "approve"
    })).toEqual({ ok: true });
  });

  test("resumes a ready cold-start checkpoint through the default continuation runner", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-resume-rpc-"));
    sendAgentMessageMock.mockClear();
    const threadId = "thread-runtime-state";
    const runId = "run-resume";
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    const runStore = createFileBackedLumeRunStateStore(sessionDir);
    await runStore.create({
      version: 1,
      runId,
      threadId,
      workspaceId: "workspace-1",
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "paused",
      input: {
        userMessage: "original task",
        permissionMode: "default",
        messageMetadata: { source: "test" }
      },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-resume",
      model: {
        provider: "openai",
        modelId: "gpt-test",
        modelRef: "openai/gpt-test",
        channelId: "channel-1"
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });
    await createFileBackedRunContinuationStore(sessionDir).upsert({
      version: 1,
      runId,
      threadId,
      status: "ready_to_resume",
      checkpoint: {
        step: "after_tool_result",
        interruptionId: "ask_user:tool-1",
        toolCallId: "tool-1",
        toolName: "AskUserQuestion",
        toolKind: "control",
        syntheticToolResult: {
          status: "answered",
          answers: { scope: "continue" }
        }
      },
      reason: "AskUserQuestion 已回答，恢复时将注入答案。",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const resume = await handlers[AGENT_IPC_CHANNELS.RESUME_RUN]!({ threadId, runId });

    expect(resume).toEqual({
      status: "resumed",
      finalOutput: "resumed output"
    });
    expect(sendAgentMessageMock).toHaveBeenCalledTimes(1);
    expect(sendAgentMessageMock.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      workspaceId: "workspace-1",
      modelRef: "openai/gpt-test",
      channelId: "channel-1",
      modelId: "gpt-test",
      permissionMode: "default",
      messageMetadata: {
        source: "test",
        runtimeContinuation: {
          sourceRunId: runId,
          checkpoint: {
            toolName: "AskUserQuestion",
            syntheticToolResult: {
              status: "answered",
              answers: { scope: "continue" }
            }
          }
        }
      }
    });
    expect(sendAgentMessageMock.mock.calls[0]?.[2]).toEqual({ appendUserMessage: false });
    expect((await createFileBackedRunContinuationStore(sessionDir).get(runId))?.status).toBe("resumed");
  });
});
