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
