import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createFileBackedRunContinuationStore } from "../services/agent-runtime/runner/run-continuation-store";
import { createFileBackedLumeRunStateStore } from "../services/agent-runtime/runner/run-state-store";
import { getRuntimeCoreSessionDir } from "../services/agent-runtime/runtime-core/session-store";
import { resetPlanningTodoStoreForTests } from "../services/planning/planning-todo-store";

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
let submitAskUserQuestionAnswersResult: unknown = { ok: true };
const submitAskUserQuestionAnswersMock = mock(() => submitAskUserQuestionAnswersResult);

mock.module("../services/agent/agent-service", () => ({
  appendAgentMessage: async () => ({ queued: false }),
  sendAgentMessage: sendAgentMessageMock,
  generateAgentTitle: async () => undefined,
  generateWelcomeSuggestions: async () => [],
  listAgentMessageQueue: () => [],
  pauseAgentQueue: () => undefined,
  promoteQueuedAgentMessageToGuidance: () => undefined,
  removeQueuedAgentMessage: () => undefined,
  reorderAgentMessageQueue: () => undefined,
  resumeAgentQueue: () => undefined,
  retryQueuedAgentMessage: () => undefined,
  stopAgent: async () => undefined,
  submitAgentToolPermission: () => false,
  submitAskUserQuestionAnswers: submitAskUserQuestionAnswersMock,
  prepareAgentDispatchInput: async (input: unknown) => input,
  getAgentSubmissionReceipt: () => undefined,
  updateQueuedAgentMessage: () => undefined
}));

function createTestPlanModePhaseTracker(): PlanModePhaseTracker {
  return {
    getPhase: () => "idle",
    clearSession: () => undefined
  } as unknown as PlanModePhaseTracker;
}

describe("agent-handlers runtime state", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    resetPlanningTodoStoreForTests();
    submitAskUserQuestionAnswersResult = { ok: true };
    submitAskUserQuestionAnswersMock.mockClear();
    sendAgentMessageMock.mockClear();
    if (process.env.LUME_CONFIG_DIR) {
      rmSync(process.env.LUME_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
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

  test("auto-resumes a persisted AskUserQuestion answer through the default continuation runner", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-ask-resume-rpc-"));
    const threadId = "thread-runtime-ask-resume";
    const runId = "run-ask-resume";
    submitAskUserQuestionAnswersResult = {
      ok: true,
      handledBy: "persisted",
      threadId,
      runId
    };
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    const runStore = createFileBackedLumeRunStateStore(sessionDir);
    await runStore.create({
      version: 1,
      runId,
      threadId,
      workspaceId: "workspace-ask",
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "paused",
      input: {
        userMessage: "plan something",
        permissionMode: "plan",
        messageMetadata: { source: "ask-test" }
      },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-ask-resume",
      model: {
        provider: "openai",
        modelId: "gpt-test",
        modelRef: "openai/gpt-test"
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
        interruptionId: "ask_user:ask-1",
        toolCallId: "ask-1",
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

    const result = await handlers[AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION]!({
      threadId,
      toolUseId: "ask-1",
      answers: { scope: "continue" }
    });

    expect(result).toEqual({
      ok: true,
      handledBy: "persisted",
      threadId,
      runId,
      resume: {
        status: "resumed",
        finalOutput: "resumed output"
      }
    });
    expect(sendAgentMessageMock).toHaveBeenCalledTimes(1);
    expect(sendAgentMessageMock.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      workspaceId: "workspace-ask",
      modelRef: "openai/gpt-test",
      permissionMode: "plan",
      messageMetadata: {
        source: "ask-test",
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
  });

  test("does not cold-start resume live AskUserQuestion answers", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-ask-live-rpc-"));
    const threadId = "thread-runtime-ask-live";
    const runId = "run-ask-live";
    submitAskUserQuestionAnswersResult = {
      ok: true,
      handledBy: "live",
      threadId,
      approvalThreadId: threadId,
      runId
    };
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    const runStore = createFileBackedLumeRunStateStore(sessionDir);
    await runStore.create({
      version: 1,
      runId,
      threadId,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "paused",
      input: {
        userMessage: "plan something",
        permissionMode: "plan"
      },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-ask-live",
      model: {
        provider: "openai",
        modelId: "gpt-test"
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
        interruptionId: "ask_user:ask-live",
        toolCallId: "ask-live",
        toolName: "AskUserQuestion",
        toolKind: "control",
        syntheticToolResult: {
          status: "answered",
          answers: { scope: "continue" }
        }
      },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const result = await handlers[AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION]!({
      threadId,
      toolUseId: "ask-live",
      answers: { scope: "continue" }
    });

    expect(result).toEqual({
      ok: true,
      handledBy: "live",
      threadId,
      approvalThreadId: threadId,
      runId
    });
    expect(sendAgentMessageMock).not.toHaveBeenCalled();
    expect((await createFileBackedRunContinuationStore(sessionDir).get(runId))?.status).toBe("ready_to_resume");
  });

  test("get-pending-resume reports interrupted runs and stays false for clean threads", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-pending-resume-"));
    const threadId = "thread-pending-resume";
    const runId = "run-pending-resume";
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    await createFileBackedLumeRunStateStore(sessionDir).create({
      version: 1,
      runId,
      threadId,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "paused",
      input: { userMessage: "original task", permissionMode: "default" },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-pending-resume",
      model: { provider: "openai", modelId: "gpt-test" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });
    const { persistAbortContinuation } = await import("../services/agent-runtime/interruption/abort-continuation");
    await persistAbortContinuation({
      sessionDir,
      runId,
      threadId,
      pendingToolCalls: [{ id: "t1", name: "Bash", input: { command: "ls" } }]
    });

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const pending = await handlers[AGENT_IPC_CHANNELS.GET_PENDING_RESUME]!({ threadId });
    expect(pending).toMatchObject({
      threadId,
      hasPendingResume: true,
      runId
    });

    const clean = await handlers[AGENT_IPC_CHANNELS.GET_PENDING_RESUME]!({ threadId: "thread-clean-pending" });
    expect(clean).toEqual({ threadId: "thread-clean-pending", hasPendingResume: false });
  });

  test("resume-run falls back to a dangling resume message when no continuation checkpoint exists", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-dangling-fallback-"));
    const threadId = "thread-dangling-fallback";
    const runId = "run-dangling-fallback";
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    await createFileBackedLumeRunStateStore(sessionDir).create({
      version: 1,
      runId,
      threadId,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "cancelled",
      input: { userMessage: "interrupted task", permissionMode: "default" },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-dangling",
      model: { provider: "openai", modelId: "gpt-test" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const result = await handlers[AGENT_IPC_CHANNELS.RESUME_RUN]!({ threadId });

    expect(result).toEqual({
      status: "resumed",
      finalOutput: "resumed output"
    });
    expect(sendAgentMessageMock).toHaveBeenCalledTimes(1);
    expect(sendAgentMessageMock.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageMetadata: {
        runtimeContinuation: {
          source: "dangling-fallback",
          sourceRunId: runId
        }
      }
    });
    expect(sendAgentMessageMock.mock.calls[0]?.[2]).toEqual({ appendUserMessage: false });
  });

  test("resume-run does not trigger dangling fallback for active runs without continuation", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-dangling-gated-"));
    const threadId = "thread-dangling-gated";
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    await createFileBackedLumeRunStateStore(sessionDir).create({
      version: 1,
      runId: "run-dangling-gated",
      threadId,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "running",
      input: { userMessage: "in-flight task", permissionMode: "default" },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-dangling-gated",
      model: { provider: "openai", modelId: "gpt-test" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const result = await handlers[AGENT_IPC_CHANNELS.RESUME_RUN]!({ threadId }) as { status: string; error?: string };

    expect(result.status).toBe("not_resumable");
    expect(result.error).toContain("找不到可恢复 turn checkpoint");
    expect(sendAgentMessageMock).not.toHaveBeenCalled();
  });

  test("get-pending-resume stays silent for tool_running and waiting_background continuations", async () => {
    // F2: 这两个状态已有审批/后台交互提示，横幅不再双重提示。
    for (const continuationStatus of ["tool_running", "waiting_background"] as const) {
      process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), `lume-runtime-pending-${continuationStatus}-`));
      const threadId = `thread-pending-${continuationStatus}`;
      const runId = `run-pending-${continuationStatus}`;
      const sessionDir = getRuntimeCoreSessionDir(threadId);
      await createFileBackedLumeRunStateStore(sessionDir).create({
        version: 1,
        runId,
        threadId,
        rootAgentId: "runtime-core",
        currentAgentId: "runtime-core",
        status: "paused",
        input: { userMessage: "paused task", permissionMode: "default" },
        generatedItems: [],
        pendingInterruptions: [],
        approvals: { alwaysAllowedTools: [] },
        traceId: `trace-${continuationStatus}`,
        model: { provider: "openai", modelId: "gpt-test" },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z"
      });
      await createFileBackedRunContinuationStore(sessionDir).upsert({
        version: 2,
        runId,
        threadId,
        status: continuationStatus,
        checkpoint: {
          step: "waiting_for_tool_result",
          toolCallId: "tool-1",
          toolName: "Bash",
          toolKind: "execute",
          toolCall: {
            id: "tool-1",
            name: "Bash",
            input: { command: "ls" },
            inputHash: "hash-1",
            kind: "execute"
          }
        },
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z"
      });

      const { createAgentHandlers } = await import("./agent-handlers");
      const handlers = createAgentHandlers({
        writeNotification: () => undefined,
        planModePhaseTracker: createTestPlanModePhaseTracker(),
        notifyPlanModePhaseChange: () => undefined
      });

      const pending = await handlers[AGENT_IPC_CHANNELS.GET_PENDING_RESUME]!({ threadId });
      expect(pending).toEqual({ threadId, hasPendingResume: false });
    }
  });

  test("get-pending-resume flags a crashed running run with dangling tool_use", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-pending-crash-"));
    const threadId = "thread-pending-crash";
    const runId = "run-pending-crash";
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    await createFileBackedLumeRunStateStore(sessionDir).create({
      version: 1,
      runId,
      threadId,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "running",
      input: { userMessage: "crashed task", permissionMode: "default" },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-pending-crash",
      model: { provider: "openai", modelId: "gpt-test" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });
    // 崩溃残留：assistant tool_use 已落盘（message 级持久化），无 tool_result。
    const { createOrResumeRuntimeCoreSessionManager } = await import("../services/agent-runtime/runtime-core/session-store");
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), threadId);
    sessionManager.appendMessage({
      role: "user",
      content: "run this"
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t-crash", name: "Bash", input: { command: "ls" } }]
    });

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const pending = await handlers[AGENT_IPC_CHANNELS.GET_PENDING_RESUME]!({ threadId });
    expect(pending).toMatchObject({
      threadId,
      hasPendingResume: true,
      runId
    });

    // 对照：running 但无悬空（工具结果已配对）不触发。
    sessionManager.appendMessage({
      role: "toolResult",
      content: "done",
      toolCallId: "t-crash"
    });
    const clean = await handlers[AGENT_IPC_CHANNELS.GET_PENDING_RESUME]!({ threadId });
    expect(clean).toEqual({ threadId, hasPendingResume: false });
  });

  test("resume-run sends a plain continuation message for interrupted checkpoints without tool result injection", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-interrupted-continue-"));
    const threadId = "thread-interrupted-continue";
    const runId = "run-interrupted-continue";
    const sessionDir = getRuntimeCoreSessionDir(threadId);
    await createFileBackedLumeRunStateStore(sessionDir).create({
      version: 1,
      runId,
      threadId,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "cancelled",
      input: { userMessage: "interrupted task", permissionMode: "default" },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-interrupted-continue",
      model: { provider: "openai", modelId: "gpt-test" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });
    await createFileBackedRunContinuationStore(sessionDir).upsert({
      version: 2,
      runId,
      threadId,
      status: "interrupted",
      checkpoint: {
        step: "waiting_for_tool_result",
        toolCallId: "t1",
        toolName: "Bash",
        toolKind: "execute",
        toolCall: {
          id: "t1",
          name: "Bash",
          input: { command: "ls" },
          inputHash: "hash-1",
          kind: "execute"
        }
      },
      reason: "run 已被用户中止；恢复时从首个 pending 工具断点继续。",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });

    const { createAgentHandlers } = await import("./agent-handlers");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });

    const result = await handlers[AGENT_IPC_CHANNELS.RESUME_RUN]!({ threadId, runId });

    expect(result).toEqual({
      status: "resumed",
      finalOutput: "resumed output"
    });
    expect(sendAgentMessageMock).toHaveBeenCalledTimes(1);
    // 关键断言：runtimeContinuation 不携带 checkpoint/toolCall —— engine 消费侧
    // (resolvePersistedToolContinuation) 拿不到注入物，历史中的中断占位成为该
    // tool_use_id 的唯一 tool_result，不会产生重复。
    expect(sendAgentMessageMock.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageMetadata: {
        runtimeContinuation: {
          source: "interrupted-continue",
          sourceRunId: runId
        }
      }
    });
    expect(
      (sendAgentMessageMock.mock.calls[0]?.[0] as { messageMetadata?: { runtimeContinuation?: { checkpoint?: unknown } } })
        .messageMetadata?.runtimeContinuation?.checkpoint
    ).toBeUndefined();
    expect((sendAgentMessageMock.mock.calls[0]?.[0] as { userMessage?: string }).userMessage).toContain("中断占位");
    expect((await createFileBackedRunContinuationStore(sessionDir).get(runId))?.status).toBe("resumed");
  });

  test("run_aborted event persists an interrupted continuation checkpoint", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-runtime-abort-continuation-"));
    const threadId = "thread-runtime-abort";
    const sessionDir = getRuntimeCoreSessionDir(threadId);

    const { persistAbortContinuation } = await import("../services/agent-runtime/interruption/abort-continuation");
    await persistAbortContinuation({
      sessionDir,
      runId: "run-1",
      threadId,
      pendingToolCalls: [{ id: "t1", name: "Bash", input: { command: "ls" } }]
    });

    const state = await createFileBackedRunContinuationStore(sessionDir).get("run-1");
    expect(state?.status).toBe("interrupted");
    expect(state?.version).toBe(2);
    expect(state?.checkpoint.step).toBe("waiting_for_tool_result");
    expect(state?.checkpoint.toolCall?.name).toBe("Bash");
    expect(state?.checkpoint.toolKind).toBe("execute");
    expect(typeof state?.checkpoint.toolCall?.inputHash).toBe("string");
  });
});
