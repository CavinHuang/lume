import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMessageAppendedEvent, SDKMessage } from "@lume/shared";
import {
  isMockRuntimeModelFallbackRetryable,
  resolveMockRuntimeModelAttemptParams
} from "../agent-runtime/runtime-core/attempt-test-helpers";

const heldRunResolvers = new Map<string, () => void>();
const runAgentRuntimeCalls: unknown[] = [];
// 模拟 attempt.ts 的 activePiSessions,供 isAgentRuntimeSessionActive mock 读取
const activeMockSessions = new Set<string>();

function emitSuccessfulRun(emit: {
  onSdkMessage: (message: SDKMessage) => void;
  onRuntimeEvent?: (event: unknown) => void;
  onComplete: () => void;
}): void {
  emit.onRuntimeEvent?.({
    id: "runtime-1",
    type: "assistant.delta",
    threadId: "thread-1",
    runId: "run-1",
    createdAt: "2026-05-11T00:00:00.000Z",
    delta: "mock assistant output"
  });
  emit.onSdkMessage({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: "mock assistant output"
      }]
    }
  } as SDKMessage);
  emit.onSdkMessage({
    type: "result",
    subtype: "success",
    duration_ms: 12,
    contextUsage: {
      source: "provider",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      totalTokens: 20,
      estimatedTailTokens: 0,
      contextWindow: 1000,
      contextWindowSource: "model"
    },
    billingUsage: {
      cumulative: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        totalTokens: 20
      },
      latestRecord: {
        callerLabel: "Turn 1",
        model: "model-test",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        totalTokens: 20,
        costUSD: 0.01,
        usageIdentity: {
          threadId: "thread-1",
          callerKind: "conversation",
          turn: 1
        }
      },
      records: [],
      totalCostUSD: 0.01
    },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2
    }
  } as SDKMessage);
  emit.onComplete();
}

function emitRunWithSubagentTranscript(emit: {
  onSdkMessage: (message: SDKMessage) => void;
  onComplete: () => void;
}): void {
  emit.onSdkMessage({
    type: "assistant",
    subagent_run_id: "subagent-run-1",
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: "subagent assistant output"
      }]
    }
  } as SDKMessage);
  emit.onSdkMessage({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: "parent assistant output"
      }]
    }
  } as SDKMessage);
  emit.onSdkMessage({
    type: "result",
    subtype: "success",
    duration_ms: 12,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  } as SDKMessage);
  emit.onComplete();
}

function emitRunWithCompactionSummary(emit: {
  onSdkMessage: (message: SDKMessage) => void;
  onComplete: () => void;
}): void {
  emit.onSdkMessage({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "auto",
      pre_tokens: 1234,
      summary: "The session established structured memory flush from compaction summaries."
    }
  } as SDKMessage);
  emitSuccessfulRun(emit);
}

function emitManualCompaction(emit: {
  onSdkMessage: (message: SDKMessage) => void;
  onRuntimeEvent?: (event: unknown) => void;
  onComplete: () => void;
}): void {
  emit.onSdkMessage({
    type: "system",
    subtype: "context_compaction_started",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 1234,
      policy: "kernel-v1",
      source: "agent-runtime-kernel"
    }
  } as SDKMessage);
  emit.onRuntimeEvent?.({
    id: "compact-started",
    type: "context.compaction.started",
    threadId: "thread-test",
    runId: "run-test",
    createdAt: "2026-05-17T00:00:00.000Z",
    trigger: "manual",
    preTokens: 1234,
    policy: "kernel-v1",
    source: "agent-runtime-kernel"
  });
  emit.onSdkMessage({
    type: "system",
    subtype: "context_compaction_progress",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 1234,
      stage: "summarizing",
      progress: 45,
      message: "正在生成上下文摘要",
      policy: "kernel-v1",
      source: "agent-runtime-kernel"
    }
  } as SDKMessage);
  emit.onRuntimeEvent?.({
    id: "compact-progress",
    type: "context.compaction.progress",
    threadId: "thread-test",
    runId: "run-test",
    createdAt: "2026-05-17T00:00:00.500Z",
    trigger: "manual",
    preTokens: 1234,
    stage: "summarizing",
    progress: 45,
    message: "正在生成上下文摘要",
    policy: "kernel-v1",
    source: "agent-runtime-kernel"
  });
  emit.onRuntimeEvent?.({
    id: "compact-completed",
    type: "context.compaction.completed",
    threadId: "thread-test",
    runId: "run-test",
    createdAt: "2026-05-17T00:00:01.000Z",
    trigger: "manual",
    preTokens: 1234,
    postTokens: 300,
    policy: "kernel-v1",
    source: "agent-runtime-kernel",
    summary: "Manual compact summary."
  });
  emit.onSdkMessage({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 1234,
      post_tokens: 300,
      summary: "Manual compact summary.",
      policy: "kernel-v1",
      source: "agent-runtime-kernel"
    }
  } as SDKMessage);
  emit.onSdkMessage({
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  } as SDKMessage);
  emit.onComplete();
}

async function waitForQueuedRunRelease(userMessage: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const resolver = heldRunResolvers.get(userMessage);
    if (resolver) {
      resolver();
      heldRunResolvers.delete(userMessage);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`queued run resolver not found: ${userMessage}`);
}

// 等待 mock runtime session 进入 active 状态(模拟 isAgentRuntimeSessionActive 为 true 的窗口)
async function waitForMockSessionActive(threadId: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (activeMockSessions.has(threadId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`mock runtime session never became active: ${threadId}`);
}

mock.module("../agent-runtime/runtime-core/attempt", () => ({
  runAgentRuntime: async (
    params: unknown,
    emit: {
      onSdkMessage: (message: SDKMessage) => void;
      onRuntimeEvent?: (event: unknown) => void;
      onComplete: () => void;
      onError: (error: string) => void;
    }
  ) => {
    runAgentRuntimeCalls.push(params);
    const userMessage = (params as { input?: { userMessage?: string } })?.input?.userMessage ?? "";
    const threadId = (params as { runtime?: { sessionId?: string } })?.runtime?.sessionId ?? "";
    const visibleUserMessage = (params as { runtime?: { visibleUserMessage?: string } })?.runtime?.visibleUserMessage ?? "";
    activeMockSessions.add(threadId);
    try {
    if (userMessage === "subagent-projection") {
      emitRunWithSubagentTranscript(emit);
      return { status: "completed" as const };
    }
    if (visibleUserMessage === "把这个文件收好") {
      emitSuccessfulRun(emit);
      const metadata = (params as { input?: { messageMetadata?: Record<string, unknown> } }).input?.messageMetadata;
      return {
        status: "completed" as const,
        codingReport: {
          runId: "run-lazy-coding",
          turnId: metadata?.turnId,
          userMessageId: metadata?.messageId,
          phase: "ready_for_review" as const,
          status: "unverified" as const,
          workspaceChanged: true,
          changedFiles: ["notes.txt"],
          fileChanges: [{ path: "notes.txt", addedLines: 1, removedLines: 0 }],
          externalChangedFiles: [],
          pendingBackground: false,
          rewindState: "available" as const
        }
      };
    }
    if (userMessage === "compact-summary") {
      emitRunWithCompactionSummary(emit);
      return { status: "completed" as const };
    }
    if (userMessage === "/compact") {
      emitManualCompaction(emit);
      return { status: "completed" as const };
    }
    if (userMessage === "late-background-notification") {
      emitSuccessfulRun(emit);
      setTimeout(() => {
        emit.onSdkMessage({
          type: "system",
          subtype: "task_notification",
          task_id: "task_late",
          status: "completed",
          summary: "late task completed",
          output_file: "C:\\temp\\late.log",
          session_id: threadId
        } as SDKMessage);
      }, 5);
      return { status: "completed" as const };
    }
    if (userMessage === "failed-run") {
      emit.onSdkMessage({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "temporary failed output" }],
        },
      } as SDKMessage);
      emit.onSdkMessage({
        type: "result",
        subtype: "error",
        error: "network failed",
      } as SDKMessage);
      emit.onError("network failed");
      return { status: "errored" as const, errorMessage: "network failed" };
    }
    if (userMessage === "subagent-announce-during-run") {
      const { announceSubagentCompletion } = await import("./subagents/subagent-announce-service");
      await announceSubagentCompletion({
        run: {
          runId: `mock-subagent-run:${threadId}`,
          parentThreadId: threadId,
          rootThreadId: threadId,
          depth: 1,
          childThreadId: `mock-child-thread:${threadId}`,
          label: "Mock Subagent",
          task: "mock subagent completion",
          status: "completed",
          cleanup: "keep",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          outcome: {
            output: "mock subagent announce output"
          }
        }
      });
      emitSuccessfulRun(emit);
      return { status: "completed" as const };
    }
    if (userMessage.startsWith("hold:")) {
      await new Promise<void>((resolve) => {
        heldRunResolvers.set(userMessage, () => {
          emitSuccessfulRun(emit);
          resolve();
        });
      });
      return { status: "completed" as const };
    }
    emitSuccessfulRun(emit);
    return { status: "completed" as const };
  } finally {
    activeMockSessions.delete(threadId);
  }
  },
  isRuntimeModelFallbackRetryable: isMockRuntimeModelFallbackRetryable,
  resolveRuntimeModelAttemptParams: resolveMockRuntimeModelAttemptParams,
  stopAgentRuntime: () => undefined,
  isAgentRuntimeSessionActive: (threadId: string) => activeMockSessions.has(threadId)
}));

const createConnectionLlmProviderSpy = mock(async () => ({
  apiType: "openai-completions" as const,
  createMessage: async () => ({
    content: [{ type: "text" as const, text: "模型供应商配置" }],
    stopReason: "end_turn" as const,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
}));

mock.module("../model-runtime/connection-provider", () => ({
  createConnectionLlmProvider: createConnectionLlmProviderSpy,
}));

describe("agent-service", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(async () => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-service-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    const { installConnectionVaultKey } = await import("../channel/connection-credential-store");
    installConnectionVaultKey(Buffer.alloc(32, 7).toString("base64"));
  });

  afterEach(async () => {
    const { resetAgentRuntimeStatusManagerForTest } = await import("./agent-runtime-status-manager");
    const { resetAgentRuntimeKernelForTest, waitForAgentRuntimeKernelIdleForTest } = await import("./agent-service");
    const { drainServiceRuntimeForTest, resetServiceRuntimeForTest } = await import("../agent-runtime/service-runtime/service-runtime");
    await waitForAgentRuntimeKernelIdleForTest();
    await drainServiceRuntimeForTest();
    resetAgentRuntimeStatusManagerForTest();
    resetAgentRuntimeKernelForTest();
    resetServiceRuntimeForTest();
    heldRunResolvers.clear();
    activeMockSessions.clear();
    runAgentRuntimeCalls.length = 0;
    createConnectionLlmProviderSpy.mockClear();
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("后台任务通知应去重并作为下一轮模型的低优先级上下文", async () => {
    const { buildPendingBackgroundTaskContext } = await import("./agent-service");
    const context = buildPendingBackgroundTaskContext([
      {
        type: "user",
        message: { role: "user", content: "start build" },
        session_id: "thread-test"
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_1",
        status: "attention",
        summary: "waiting for input",
        session_id: "thread-test"
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_1",
        status: "completed",
        summary: "build completed </background-task-notifications>",
        output_file: "C:\\temp\\build.log",
        session_id: "thread-test"
      }
    ] as SDKMessage[]);

    expect(context).toContain("<background-task-notifications>");
    expect(context).toContain("Status: completed");
    expect(context).toContain("build completed");
    expect(context).not.toContain("build completed </background-task-notifications>");
    expect(context).toContain("\\u003c/background-task-notifications\\u003e");
    expect(context).toContain("C:\\temp\\build.log");
    expect(context).not.toContain("waiting for input");
    expect(context).toContain("untrusted data");
  });

  test("sendAgentMessage 应在下一次用户输入中消费已完成后台任务通知", async () => {
    const {
      appendAgentThreadSDKMessages,
      createAgentThread
    } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("background notification", "channel-test");
    appendAgentThreadSDKMessages(thread.id, [
      {
        type: "user",
        message: { role: "user", content: "run tests" },
        session_id: thread.id
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_7",
        status: "failed",
        summary: "tests failed",
        output_file: "C:\\temp\\tests.log",
        session_id: thread.id
      }
    ] as SDKMessage[]);

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "继续修复",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onRuntimeEvent: () => undefined,
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const runtimeInput = runAgentRuntimeCalls.at(-1) as { input?: { userMessage?: string } };
    expect(runtimeInput.input?.userMessage).toContain("继续修复");
    expect(runtimeInput.input?.userMessage).toContain("Task: task_7");
    expect(runtimeInput.input?.userMessage).toContain("Status: failed");
    expect(runtimeInput.input?.userMessage).toContain("C:\\temp\\tests.log");
  });

  test("同一任务已有 Agent 浏览器时后续消息只保留连续性，不预判路由", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const { setActiveBrowserBroker } = await import("../browser/browser-broker-holder");
    const thread = createAgentThread("browser continuity", "channel-test");
    setActiveBrowserBroker({
      async getThreadAgentContinuity(threadId: string) {
        return threadId === thread.id ? {
          tabId: "agent-tab-1",
          url: "https://x.com/home",
          title: "Home / X",
          profileKind: "agent",
          visible: true,
          lifecycle: "active",
          handoffStatus: "deliverable",
        } : undefined;
      }
    } as any);

    try {
      await sendAgentMessage({
        threadId: thread.id,
        userMessage: "看下当前最新十条 post 说了什么",
        channelId: "channel-test",
        modelId: "provider/model-test"
      }, {
        onRuntimeEvent: () => undefined,
        onMessageAppended: () => undefined,
        onComplete: () => undefined,
        onError: () => undefined,
        onTitleUpdated: () => undefined,
        onAskUserQuestion: () => undefined,
        onBrowserAuthRequest: () => undefined,
        onToolPermissionRequest: () => undefined
      });

      const runtimeInput = runAgentRuntimeCalls.at(-1) as { input?: { messageMetadata?: Record<string, unknown> } };
      expect(runtimeInput.input?.messageMetadata).toMatchObject({
        browserContinuity: {
          tabId: "agent-tab-1",
          url: "https://x.com/home",
          handoffStatus: "deliverable"
        }
      });
    } finally {
      setActiveBrowserBroker(null);
    }
  });

  test("Run 完成后到达的后台任务通知仍应单独持久化", async () => {
    const {
      createAgentThread,
      getAgentThreadSDKMessages
    } = await import("./agent-thread-manager");
    const { listThreadRuntimeEvents } = await import("../agent-runtime/replay/runtime-event-history");
    const { getRuntimeCoreSessionDir } = await import("../agent-runtime/runtime-core/session-store");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("late background notification", "channel-test");
    const runtimeEvents: unknown[] = [];

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "late-background-notification",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onRuntimeEvent: (event) => runtimeEvents.push(event),
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getAgentThreadSDKMessages(thread.id)).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "task_notification",
      task_id: "task_late",
      status: "completed"
    }));
    // T7a 起 late 后台通知不再走旧路 live emit(runtimeEvents 回调),经 handleAsyncEvent
    // 旁路上事件总线;持久化语义由下方 SDK log + hydrate replay 双断言覆盖。
    expect(runtimeEvents).not.toContainEqual(expect.objectContaining({
      type: "background.task.completed"
    }));
    const replayed = await listThreadRuntimeEvents({
      sessionDir: getRuntimeCoreSessionDir(thread.id),
      threadId: thread.id
    });
    expect(replayed.events).toContainEqual(expect.objectContaining({
      type: "background.task.completed",
      taskId: "task_late",
      status: "completed"
    }));
  });

  test("后台任务终态通知不应创建隐藏主 agent 轮次", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { appendAgentMessage, waitForAgentRuntimeKernelIdleForTest } = await import("./agent-service");
    const thread = createAgentThread("background wake", "channel-test");
    const before = runAgentRuntimeCalls.length;

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "late-background-notification",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onDesktopActionRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    await waitForAgentRuntimeKernelIdleForTest();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runAgentRuntimeCalls).toHaveLength(before + 1);
  });

  test("sendAgentMessage 应先追加 user 可见消息，再在完成后追加 assistant 与原始 sdk transcript", async () => {
    const { createAgentThread, getAgentThreadMessages, getAgentThreadSDKMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("send lifecycle", "channel-test");
    const appended: AgentMessageAppendedEvent[] = [];
    const runtimeEvents: unknown[] = [];

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "hello agent",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event);
      },
      onMessageAppended: (event) => {
        appended.push(event);
      },
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const visibleMessages = getAgentThreadMessages(thread.id);
    const sdkMessages = getAgentThreadSDKMessages(thread.id);

    expect(appended).toHaveLength(2);
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      type: "assistant.delta",
      delta: "mock assistant output"
    }));
    expect(appended[0]?.message.role).toBe("user");
    expect(appended[0]?.message.sdkMessages?.[0]?.type).toBe("user");
    expect(appended[1]?.message.role).toBe("assistant");
    expect(appended[1]?.message.sdkMessages?.map((message) => message.type)).toEqual(["assistant", "result"]);
    expect(appended[1]?.message.metadata?.tokenUsage).toEqual({
      source: "provider",
      scope: "assistant_turn",
      providerOutputTokens: 5,
      contextUsage: {
        source: "provider",
        totalTokens: 20,
        contextWindow: 1000
      },
      billingUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        cachedTokens: 5,
        totalTokens: 20,
        costUSD: 0.01
      }
    });

    expect(visibleMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(visibleMessages[0]?.sdkMessages?.[0]?.type).toBe("user");
    expect(visibleMessages[1]?.content).toBe("mock assistant output");
    expect(visibleMessages[1]?.metadata?.tokenUsage).toEqual({
      source: "provider",
      scope: "assistant_turn",
      providerOutputTokens: 5,
      contextUsage: {
        source: "provider",
        totalTokens: 20,
        contextWindow: 1000
      },
      billingUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        cachedTokens: 5,
        totalTokens: 20,
        costUSD: 0.01
      }
    });
    expect(sdkMessages.map((message) => message.type)).toEqual(["user", "assistant", "result"]);
  });

  test("CodingTurn 只在实际修改后惰性创建且不依赖用户措辞", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const { getRuntimeCoreSessionDir } = await import("../agent-runtime/runtime-core/session-store");
    const { listCodingTurnRecords } = await import("../agent-runtime/runtime-core/coding-turn-store");
    const send = (threadId: string, userMessage: string) => sendAgentMessage({
      threadId,
      userMessage,
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const conversation = createAgentThread("ordinary conversation", "channel-test");
    await send(conversation.id, "你好，今天怎么样");
    expect(await listCodingTurnRecords(getRuntimeCoreSessionDir(conversation.id))).toHaveLength(0);

    const changed = createAgentThread("implicit file change", "channel-test");
    await send(changed.id, "把这个文件收好");
    const turns = await listCodingTurnRecords(getRuntimeCoreSessionDir(changed.id));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.changedFiles).toEqual([{ path: "notes.txt", addedLines: 1, removedLines: 0 }]);
  });

  test("未配置 title 模型时首轮完成后也应回退到会话渠道触发 LLM 标题生成", async () => {
    const { createChannel } = await import("../channel/channel-manager");
    const { createAgentThread } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const { drainServiceRuntimeForTest } = await import("../agent-runtime/service-runtime/service-runtime");

    // 真实渠道：让 generateAgentTitle 能解析到渠道并走统一 Connection provider。
    const channel = createChannel({
      name: "title-test",
      provider: "openai",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-title-test",
      enabled: true,
      models: [{ id: "model-test", name: "Model Test", enabled: true, capabilities: { chat: true } }]
    });
    createConnectionLlmProviderSpy.mockClear();
    // 默认标题，确保走 shouldTryAutoTitle 分支
    const thread = createAgentThread("新 Agent 线程", channel.id);

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "帮我配置一个新的模型供应商",
      channelId: channel.id,
      modelId: "model-test"
    }, {
      onRuntimeEvent: () => undefined,
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });
    await drainServiceRuntimeForTest();

    // 默认配置未设置 models.title.defaultModelRef，仍应回退到会话渠道调用统一 provider。
    expect(createConnectionLlmProviderSpy).toHaveBeenCalled();
  });

  test("sendAgentMessage 应把本轮附件引用持久化到用户消息 metadata", async () => {
    const { createAgentThread, getAgentThreadMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("message attachments", "channel-test");

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "总结附件",
      channelId: "channel-test",
      modelId: "provider/model-test",
      messageAttachments: [{
        id: "att-1",
        filename: "brief.md",
        mediaType: "text/markdown",
        size: 2048,
        threadPath: "docs/brief.md"
      }]
    }, {
      onRuntimeEvent: () => undefined,
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const visibleMessages = getAgentThreadMessages(thread.id);
    expect(visibleMessages[0]?.metadata?.messageAttachments).toEqual([{
      id: "att-1",
      filename: "brief.md",
      mediaType: "text/markdown",
      size: 2048,
      threadPath: "docs/brief.md"
    }]);
  });

  test("sendAgentMessage 不应把隐藏的 plan 控制输入追加为可见用户消息", async () => {
    const { createAgentThread, getAgentThreadMessages, getAgentThreadSDKMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("hidden plan control", "channel-test");
    const appended: AgentMessageAppendedEvent[] = [];
    const runtimeEvents: unknown[] = [];

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "请按顺序自动继续执行当前未完成计划。",
      channelId: "channel-test",
      modelId: "provider/model-test",
      messageMetadata: {
        hiddenFromChat: true,
        planControlEvent: "continue_plan"
      }
    }, {
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event);
      },
      onMessageAppended: (event) => {
        appended.push(event);
      },
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    expect(appended.some((event) => event.message.role === "user")).toBe(false);
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      type: "assistant.delta",
      delta: "mock assistant output"
    }));
    expect(getAgentThreadMessages(thread.id).some((message) => message.role === "user")).toBe(false);
    expect(getAgentThreadSDKMessages(thread.id).map((message) => message.type)).toEqual(["assistant", "result"]);
  });

  test("/compact 应作为隐藏能力命令执行，不追加可见用户消息", async () => {
    const { createAgentThread, getAgentThreadMessages, getAgentThreadSDKMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("manual compact command", "channel-test");
    const appended: AgentMessageAppendedEvent[] = [];
    const runtimeEvents: unknown[] = [];

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "/compact",
      messageMetadata: { hiddenFromChat: true, manualCommand: "compact" },
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onRuntimeEvent: (event) => runtimeEvents.push(event),
      onMessageAppended: (event) => appended.push(event),
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    expect(appended).toEqual([]);
    expect(getAgentThreadMessages(thread.id)).toEqual([]);
    expect(getAgentThreadSDKMessages(thread.id).map((message) =>
      message.type === "system" ? message.subtype : message.type
    )).toEqual(["context_compaction_started", "context_compaction_progress", "compact_boundary", "result"]);
    expect(runtimeEvents).not.toContainEqual(expect.objectContaining({
      type: "message.user.submitted",
      text: "/compact"
    }));
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      type: "context.compaction.progress",
      trigger: "manual",
      stage: "summarizing",
      progress: expect.any(Number)
    }));
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      type: "context.compaction.completed",
      trigger: "manual"
    }));
  });

  test("sendAgentMessage 在 turn-limited 后保留用户原文并附加客观恢复状态", async () => {
    const { createAgentThread, getAgentThreadMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const { getRuntimeCoreSessionDir } = await import("../agent-runtime/runtime-core/session-store");
    const { createFileBackedLumeRunStateStore } = await import("../agent-runtime/runner/run-state-store");
    const thread = createAgentThread("turn limited continue", "channel-test");
    const sessionDir = getRuntimeCoreSessionDir(thread.id);
    await createFileBackedLumeRunStateStore(sessionDir).create({
      version: 1,
      runId: "run-turn-limited",
      threadId: thread.id,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "completed",
      currentStep: {
        id: "step-finalize",
        type: "finalize",
        status: "completed",
        startedAt: "2026-05-22T00:00:00.000Z",
        endedAt: "2026-05-22T00:00:00.000Z"
      },
      input: {
        userMessage: "original task",
        permissionMode: "default"
      },
      generatedItems: [{
        type: "system_event",
        id: "turn-limited",
        name: "turn_limited",
        payload: {
          reason: "Agent SDK 达到最大回合数（80），本轮需要继续执行。"
        },
        createdAt: "2026-05-22T00:00:00.000Z"
      }],
      pendingInterruptions: [],
      approvals: {
        alwaysAllowedTools: []
      },
      traceId: "trace-1",
      model: {
        provider: "provider",
        modelId: "model-test"
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
      completedAt: "2026-05-22T00:00:00.000Z"
    });

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "继续",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    expect(getAgentThreadMessages(thread.id)[0]?.content).toBe("继续");
    const modelMessage = (runAgentRuntimeCalls.at(-1) as { input?: { userMessage?: string } })?.input?.userMessage ?? "";
    expect(modelMessage).toContain('<runtime-recovery-state reason="turn_limit">');
    expect(modelMessage.endsWith("继续")).toBeTrue();
    expect(modelMessage).not.toContain("请继续完成上一轮未完成的原始任务");
    expect((runAgentRuntimeCalls.at(-1) as { runtime?: { visibleUserMessage?: string } })?.runtime?.visibleUserMessage)
      .toBe("继续");
  });

  test("失败运行不应把临时 assistant 结果写回会话上下文", async () => {
    const { createAgentThread, getAgentThreadMessages, getAgentThreadSDKMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("failed transcript", "channel-test");

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "failed-run",
      channelId: "channel-test",
      modelId: "provider/model-test",
    }, {
      onMessageAppended: () => undefined,
      onRuntimeEvent: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined,
    });

    expect(getAgentThreadMessages(thread.id).map((message) => message.role)).toEqual(["user"]);
    expect(getAgentThreadSDKMessages(thread.id).map((message) => message.type)).toEqual(["user"]);
  });

  test("手写 /compact 未携带结构化动作标记时按普通文本发送", async () => {
    const { createAgentThread, getAgentThreadMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("literal compact text", "channel-test");
    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "/compact",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onToolPermissionRequest: () => undefined
    });
    expect(getAgentThreadMessages(thread.id).some((message) => (
      message.role === "user" && message.content === "/compact"
    ))).toBe(true);
  });

  test("sendAgentMessage 在进程重启后为任意新消息附加未完成 run 状态", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const { getRuntimeCoreSessionDir } = await import("../agent-runtime/runtime-core/session-store");
    const { createFileBackedLumeRunStateStore } = await import("../agent-runtime/runner/run-state-store");
    const thread = createAgentThread("stale running continue", "channel-test");
    const sessionDir = getRuntimeCoreSessionDir(thread.id);
    await createFileBackedLumeRunStateStore(sessionDir).create({
      version: 1,
      runId: "run-stale-running",
      threadId: thread.id,
      rootAgentId: "runtime-core",
      currentAgentId: "runtime-core",
      status: "running",
      currentStep: {
        id: "step-model",
        type: "model_call",
        status: "running",
        startedAt: "2026-05-24T12:01:58.000Z"
      },
      input: {
        userMessage: "分析 Alice.app 世界观和主动动作",
        permissionMode: "bypassPermissions"
      },
      generatedItems: [{
        type: "assistant_message",
        id: "assistant-progress",
        content: [{ type: "text", text: "已读取目录结构，准备分析核心文件。" }],
        createdAt: "2026-05-24T12:02:10.000Z"
      }, {
        type: "tool_call",
        id: "call-count-js",
        toolName: "Bash",
        input: {
          command: "find /Applications/Alice.app/Contents/Resources/app/out -type f -name \"*.js\" | wc -l"
        },
        parentAgentId: "runtime-core",
        status: "completed",
        createdAt: "2026-05-24T12:02:11.000Z"
      }, {
        type: "tool_result",
        id: "result-count-js",
        toolCallId: "call-count-js",
        toolName: "Bash",
        output: "130\n",
        createdAt: "2026-05-24T12:02:12.000Z"
      }],
      pendingInterruptions: [],
      approvals: {
        alwaysAllowedTools: []
      },
      traceId: "trace-stale-running",
      model: {
        provider: "provider",
        modelId: "model-test"
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      createdAt: "2026-05-24T12:01:58.000Z",
      updatedAt: "2026-05-24T12:03:43.000Z"
    });

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "换个方向，先总结目前发现",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const modelMessage = (runAgentRuntimeCalls.at(-1) as { input?: { userMessage?: string } })?.input?.userMessage ?? "";
    expect(modelMessage).toContain('<runtime-recovery-state reason="interrupted">');
    expect(modelMessage).toContain("分析 Alice.app 世界观和主动动作");
    expect(modelMessage).toContain("已读取目录结构");
    expect(modelMessage).toContain("Bash");
    expect(modelMessage).toContain("130");
    expect(modelMessage.endsWith("换个方向，先总结目前发现")).toBeTrue();
  });

  test("sendAgentMessage 在 transcript 缺失时为任意新消息附加可见历史", async () => {
    const { createAgentThread, getAgentThreadMessages } = await import("./agent-thread-manager");
    const { createUserMessageVersion } = await import("./agent-message-versioning-service");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("visible history continue", "channel-test");
    getAgentThreadMessages(thread.id);
    createUserMessageVersion({
      sessionId: thread.id,
      content: "深入分析 Alice.app 的世界观和主动动作设计",
      createdAt: Date.now(),
      sdkMessages: []
    });

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "现在只列出三个关键结论",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const modelMessage = (runAgentRuntimeCalls.at(-1) as { input?: { userMessage?: string } })?.input?.userMessage ?? "";
    expect(modelMessage).toContain("<visible-thread-history>");
    expect(modelMessage).toContain("深入分析 Alice.app 的世界观和主动动作设计");
    expect(modelMessage.endsWith("现在只列出三个关键结论")).toBeTrue();
  });

  test("sendAgentMessage 应继承线程工作区传给 runtime", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { createAgentWorkspace } = await import("./agent-workspace-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const projectPath = join(tempConfigDir, "runtime-workspace-project");
    mkdirSync(projectPath, { recursive: true });
    const workspace = createAgentWorkspace("Runtime Workspace", {
      slug: "runtime-workspace",
      projectPath
    });
    const thread = createAgentThread("workspace runtime", "channel-test", workspace.id);

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "workspace inherited",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    expect((runAgentRuntimeCalls.at(-1) as { runtime?: { workspaceId?: string } })?.runtime?.workspaceId).toBe(workspace.id);
  });

  test("appendAgentMessage 应在运行中排队并在完成后自动发送下一条", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { appendAgentMessage, waitForAgentRuntimeKernelIdleForTest } = await import("./agent-service");
    const { getAgentRuntimeStatusManager } = await import("./agent-runtime-status-manager");
    const thread = createAgentThread("queue lifecycle", "channel-test");
    const appended: AgentMessageAppendedEvent[] = [];
    const createEmit = () => ({
      onMessageAppended: (event: AgentMessageAppendedEvent) => {
        appended.push(event);
      },
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const first = appendAgentMessage({
      threadId: thread.id,
      userMessage: "hold:first",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());

    const second = appendAgentMessage({
      threadId: thread.id,
      userMessage: "second",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());

    expect(first.mode).toBe("sent");
    expect(second.mode).toBe("queued");
    expect(second.queuedCount).toBe(1);
    expect(second.queuedMessage).toEqual(expect.objectContaining({
      threadId: thread.id,
      text: "second"
    }));
    expect(getAgentRuntimeStatusManager().get(thread.id)?.queuedCount).toBe(1);

    await waitForQueuedRunRelease("hold:first");
    await waitForAgentRuntimeKernelIdleForTest();

    expect(getAgentRuntimeStatusManager().get(thread.id)?.queuedCount).toBe(0);
    expect(appended.filter((event) => event.message.role === "user").map((event) => event.message.content)).toEqual([
      "hold:first",
      "second"
    ]);
  });

  test("run 内失败不合成 runtime-error run.failed(T7c fix round 1 单源验收)", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { appendAgentMessage, waitForAgentRuntimeKernelIdleForTest } = await import("./agent-service");
    const { createAgentNotificationEmitter } = await import("./agent-notification-service");
    const { AGENT_IPC_CHANNELS } = await import("@lume/shared");
    const thread = createAgentThread("run fail single source", "channel-test");
    const notifications: Array<{ method: string; params: unknown }> = [];
    const emitter = createAgentNotificationEmitter({
      threadId: thread.id,
      writeNotification: (method, params) => notifications.push({ method, params })
    });

    // mock runtime "failed-run" 路径:emit.onError 来自 run 执行链 → 应带 fromActiveRun 抑制合成
    appendAgentMessage({
      threadId: thread.id,
      userMessage: "failed-run",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, emitter);
    await waitForAgentRuntimeKernelIdleForTest();

    const syntheticRunFailed = notifications.filter((item) => {
      if (item.method !== AGENT_IPC_CHANNELS.RUNTIME_EVENT) return false;
      const event = (item.params as { event?: { type?: string; runId?: string } }).event;
      return event?.type === "run.failed" && String(event.runId ?? "").startsWith("runtime-error:");
    });
    expect(syntheticRunFailed).toHaveLength(0);
  });

  test("无 run 启动失败(缺渠道/模型)仍合成 runtime-error run.failed 兜底", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const { createAgentNotificationEmitter } = await import("./agent-notification-service");
    const { AGENT_IPC_CHANNELS } = await import("@lume/shared");
    // 不传 channelId:线程无渠道/模型 → resolvedChannelId 缺失 → run 外启动失败分支
    const thread = createAgentThread("startup fail synth");
    const notifications: Array<{ method: string; params: unknown }> = [];
    const emitter = createAgentNotificationEmitter({
      threadId: thread.id,
      writeNotification: (method, params) => notifications.push({ method, params })
    });

    await sendAgentMessage({ threadId: thread.id, userMessage: "hi" }, emitter);

    const syntheticRunFailed = notifications.filter((item) => {
      if (item.method !== AGENT_IPC_CHANNELS.RUNTIME_EVENT) return false;
      const event = (item.params as { event?: { type?: string; runId?: string } }).event;
      return event?.type === "run.failed" && String(event.runId ?? "").startsWith("runtime-error:");
    });
    expect(syntheticRunFailed).toHaveLength(1);
    expect((syntheticRunFailed[0]!.params as { threadId: string }).threadId).toBe(thread.id);
  });

  test("队列 API 应支持列表、重排、CAS 编辑和删除排队消息", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const {
      appendAgentMessage,
      listAgentMessageQueue,
      removeQueuedAgentMessage,
      reorderAgentMessageQueue,
      updateQueuedAgentMessage,
      waitForAgentRuntimeKernelIdleForTest
    } = await import("./agent-service");
    const thread = createAgentThread("queue operations", "channel-test");
    const appended: AgentMessageAppendedEvent[] = [];
    const createEmit = () => ({
      onMessageAppended: (event: AgentMessageAppendedEvent) => {
        appended.push(event);
      },
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "hold:first",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());
    const second = appendAgentMessage({
      threadId: thread.id,
      userMessage: "second",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());
    const third = appendAgentMessage({
      threadId: thread.id,
      userMessage: "third",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());

    const beforeReorder = listAgentMessageQueue(thread.id);
    expect(beforeReorder.queuedMessages.map((item) => item.text)).toEqual(["second", "third"]);

    const reordered = reorderAgentMessageQueue({
      threadId: thread.id,
      orderedMessageIds: [
        third.queuedMessage?.id ?? "",
        second.queuedMessage?.id ?? ""
      ],
      expectedRevision: beforeReorder.revision,
      queueOperationId: "reorder-test"
    });

    expect(reordered.snapshot.queuedMessages.map((item) => item.text)).toEqual(["third", "second"]);

    const staleUpdate = updateQueuedAgentMessage({
      threadId: thread.id,
      queuedMessageId: second.queuedMessage?.id ?? "",
      expectedRevision: beforeReorder.revision,
      queueOperationId: "update-stale-test",
      userMessage: "must not apply",
      messageParts: [{ type: "text", text: "must not apply" }]
    });
    expect(staleUpdate.ok).toBe(false);

    const updated = updateQueuedAgentMessage({
      threadId: thread.id,
      queuedMessageId: second.queuedMessage?.id ?? "",
      expectedRevision: staleUpdate.snapshot.revision,
      queueOperationId: "update-test",
      userMessage: "second edited",
      messageParts: [{ type: "text", text: "second edited" }]
    });
    expect(updated.ok).toBe(true);
    expect(updated.snapshot.queuedMessages.at(-1)?.text).toBe("second edited");

    const removed = removeQueuedAgentMessage({
      threadId: thread.id,
      queuedMessageId: third.queuedMessage?.id ?? "",
      expectedRevision: updated.snapshot.revision,
      queueOperationId: "remove-test"
    });

    expect(removed.removedMessage?.text).toBe("third");
    expect(removed.snapshot.queuedMessages.map((item) => item.text)).toEqual(["second edited"]);

    await waitForQueuedRunRelease("hold:first");
    await waitForAgentRuntimeKernelIdleForTest();

    expect(appended.filter((event) => event.message.role === "user").map((event) => event.message.content)).toEqual([
      "hold:first",
      "second edited"
    ]);
  });

  test("retryQueuedAgentMessage 对不存在的队列项应返回 conflict", async () => {
    // 退化路径:runAgentRuntime mock 控制 execute 而非 validateQueued,
    // 无法稳定注入 blocked,故此处只断言 not-found 分支(runQueueOperation 捕获
    // AgentRuntimeKernelQueueConflictError 后返回 ok:false+conflict:true)。
    // blocked→retry 的端到端行为已由 kernel 测试覆盖。
    const { createAgentThread } = await import("./agent-thread-manager");
    const { appendAgentMessage, retryQueuedAgentMessage, listAgentMessageQueue, waitForAgentRuntimeKernelIdleForTest } = await import("./agent-service");
    const thread = createAgentThread("retry not found", "channel-test");
    const createEmit = () => ({
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "hold:first",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());

    const snapshot = listAgentMessageQueue(thread.id);
    const result = retryQueuedAgentMessage({
      threadId: thread.id,
      queuedMessageId: "non-existent",
      expectedRevision: snapshot.revision,
      queueOperationId: "retry-not-found-test"
    });

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);

    await waitForQueuedRunRelease("hold:first");
    await waitForAgentRuntimeKernelIdleForTest();
  });

  test("提升为引导后若未在工具调用前消费，应恢复到普通队列队首", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const {
      appendAgentMessage,
      listAgentMessageQueue,
      promoteQueuedAgentMessageToGuidance,
      waitForAgentRuntimeKernelIdleForTest
    } = await import("./agent-service");
    const thread = createAgentThread("guidance fallback", "channel-test");
    const appended: AgentMessageAppendedEvent[] = [];
    const createEmit = () => ({
      onMessageAppended: (event: AgentMessageAppendedEvent) => {
        appended.push(event);
      },
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "hold:first",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());
    const guidance = appendAgentMessage({
      threadId: thread.id,
      userMessage: "guidance",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());
    appendAgentMessage({
      threadId: thread.id,
      userMessage: "normal-next",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());

    const beforePromote = listAgentMessageQueue(thread.id);
    const promoted = promoteQueuedAgentMessageToGuidance({
      threadId: thread.id,
      queuedMessageId: guidance.queuedMessage?.id ?? "",
      expectedRevision: beforePromote.revision,
      queueOperationId: "promote-test"
    });

    expect(promoted.promotedGuidance?.text).toBe("guidance");
    expect(promoted.snapshot.pendingGuidance.map((item) => item.text)).toEqual(["guidance"]);
    expect(promoted.snapshot.queuedMessages.map((item) => item.text)).toEqual(["normal-next"]);

    await waitForQueuedRunRelease("hold:first");
    await waitForAgentRuntimeKernelIdleForTest();

    expect(listAgentMessageQueue(thread.id)).toEqual({
      threadId: thread.id,
      revision: expect.any(Number),
      queuedMessages: [],
      pendingGuidance: [],
      paused: false
    });
    expect(appended.filter((event) => event.message.role === "user").map((event) => event.message.content)).toEqual([
      "hold:first",
      "guidance",
      "normal-next"
    ]);
  });

  test("带浏览器附件的排队消息可被 promote 为富 guidance", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const {
      appendAgentMessage,
      listAgentMessageQueue,
      promoteQueuedAgentMessageToGuidance,
      waitForAgentRuntimeKernelIdleForTest
    } = await import("./agent-service");
    const thread = createAgentThread("rich-steer", "channel-test");
    const createEmit = () => ({
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "hold:active",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());
    const queued = appendAgentMessage({
      threadId: thread.id,
      userMessage: "按这张注释改",
      channelId: "channel-test",
      modelId: "provider/model-test",
      browserAttachments: [{
        id: "ba-1",
        origin: "browser-annotation",
        tab: { id: "tab-1", origin: "browser-tab", title: "T", url: "https://x" } as never,
        anchor: { kind: "text", url: "https://x", generation: 1, framePath: [], rect: { x: 0, y: 0, width: 1, height: 1 } },
        body: "按钮改红",
      } as never],
    }, createEmit());
    expect(queued.mode).toBe("queued");

    const snapshot = listAgentMessageQueue(thread.id);
    const target = snapshot.queuedMessages[0];
    expect(target).toBeDefined();
    const result = promoteQueuedAgentMessageToGuidance({
      threadId: thread.id,
      queuedMessageId: target!.id,
      expectedRevision: snapshot.revision,
      queueOperationId: "op-rich",
    });
    expect(result.ok).toBe(true);
    expect(result.promotedGuidance?.attachmentsBrief).toContain("browser_attachments");

    await waitForQueuedRunRelease("hold:active");
    await waitForAgentRuntimeKernelIdleForTest();
  });

  test("sendAgentMessage 不应把 subagent assistant 正文投影进主 assistant 可见消息", async () => {
    const { createAgentThread, getAgentThreadMessages, getAgentThreadSDKMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("subagent projection", "channel-test");

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "subagent-projection",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const visibleMessages = getAgentThreadMessages(thread.id);
    const sdkMessages = getAgentThreadSDKMessages(thread.id);
    const assistant = visibleMessages.find((message) => message.role === "assistant");

    expect(assistant?.content).toBe("parent assistant output");
    expect(assistant?.content).not.toContain("subagent assistant output");
    expect(
      sdkMessages.some((message) => (
        message.type === "assistant"
        && (message as SDKMessage & { subagent_run_id?: string }).subagent_run_id === "subagent-run-1"
      ))
    ).toBe(true);
  });

  test("sendAgentMessage 遇到 subagent completion 事件时仍应完成且不落独立 announce transcript", async () => {
    const { createAgentThread, getAgentThreadMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("subagent announce during run", "channel-test");
    const events = {
      completed: 0,
      errors: [] as string[]
    };

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "subagent-announce-during-run",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => {
        events.completed += 1;
      },
      onError: (error) => {
        events.errors.push(error);
      },
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const visibleMessages = getAgentThreadMessages(thread.id);

    expect(events.errors).toEqual([]);
    expect(events.completed).toBe(1);
    expect(visibleMessages.some((message) => message.metadata?.subagentAnnounce === true)).toBe(false);
    expect(visibleMessages.some((message) => message.role === "assistant" && message.content === "mock assistant output")).toBe(true);
  });
});

describe("stopAgent cascade (D6)", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-stop-agent-cascade-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(async () => {
    const { resetSubagentRunRegistryForTest } = await import("./subagents/subagent-run-registry");
    const { resetAgentRuntimeStatusManagerForTest } = await import("./agent-runtime-status-manager");
    const { resetAgentRuntimeKernelForTest, waitForAgentRuntimeKernelIdleForTest } = await import("./agent-service");
    await waitForAgentRuntimeKernelIdleForTest();
    resetAgentRuntimeStatusManagerForTest();
    resetAgentRuntimeKernelForTest();
    resetSubagentRunRegistryForTest();
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("中止父 thread 时级联中止运行中子会话", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { stopAgent } = await import("./agent-service");
    const { getSubagentRunRegistry } = await import("./subagents/subagent-run-registry");

    const parent = createAgentThread("父", "channel-test");
    getSubagentRunRegistry().create({
      runId: "r-cascade-1",
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      depth: 1,
      childThreadId: "child-thread-cascade-1",
      task: "运行中子会话",
      cleanup: "keep",
      status: "running"
    });
    getSubagentRunRegistry().create({
      runId: "r-cascade-accepted",
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      depth: 1,
      childThreadId: "child-thread-cascade-accepted",
      task: "已接受未启动子会话",
      cleanup: "keep",
      status: "accepted"
    });
    // 已完成的子会话不应被重复中止
    getSubagentRunRegistry().create({
      runId: "r-cascade-done",
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      depth: 1,
      childThreadId: "child-thread-cascade-done",
      task: "已完成子会话",
      cleanup: "keep",
      status: "completed"
    });

    await stopAgent(parent.id);

    const running = getSubagentRunRegistry().get("r-cascade-1");
    const accepted = getSubagentRunRegistry().get("r-cascade-accepted");
    const done = getSubagentRunRegistry().get("r-cascade-done");
    expect(running?.status).toBe("aborted");
    expect(accepted?.status).toBe("aborted");
    expect(done?.status).toBe("completed");
  });

  test("steer 模式运行中提交应直接进 guidance 而非 FIFO 队列", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { appendAgentMessage, listAgentMessageQueue } = await import("./agent-service");
    const thread = createAgentThread("steer-route", "channel-test");
    const createEmit = () => ({
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "hold:active",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());
    // 等 mock runtime session 进入 active,模拟"运行中提交"窗口
    await waitForMockSessionActive(thread.id);

    const result = appendAgentMessage({
      threadId: thread.id,
      userMessage: "直接引导",
      channelId: "channel-test",
      modelId: "provider/model-test",
      followUpQueueMode: "steer"
    }, createEmit());

    // steer 不在 FIFO 留存:queuedMessages 为空,pendingGuidance 含该文本
    const snapshot = listAgentMessageQueue(thread.id);
    expect(snapshot.queuedMessages.length).toBe(0);
    expect(snapshot.pendingGuidance.some((g) => g.text === "直接引导")).toBe(true);
    expect(result.mode).toBe("queued");
    expect(result.queuedMessage).toBeUndefined();

    await waitForQueuedRunRelease("hold:active");
  });

  test("steer 未被消费时 drain 回 queue 作为下一条消息跑(不崩)", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { appendAgentMessage, waitForAgentRuntimeKernelIdleForTest } = await import("./agent-service");
    const thread = createAgentThread("steer-drain", "channel-test");
    const createEmit = () => ({
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });
    const runCallsBefore = runAgentRuntimeCalls.length;

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "hold:active",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());
    await waitForMockSessionActive(thread.id);
    appendAgentMessage({
      threadId: thread.id,
      userMessage: "steer-drain-msg",
      channelId: "channel-test",
      modelId: "provider/model-test",
      followUpQueueMode: "steer"
    }, createEmit());
    // 不 consume:steer guidance 残留到 turn 结束 → execute.finally → restoreUnconsumedGuidanceToQueue → drain 回 queue

    await waitForQueuedRunRelease("hold:active");
    await waitForAgentRuntimeKernelIdleForTest();
    // drain 把 steer 放回 queue → startNextQueued 调度执行(证明完整 dispatch 链路不崩)
    const steerRan = runAgentRuntimeCalls
      .slice(runCallsBefore)
      .some((p) => (p as { runtime?: { visibleUserMessage?: string } })?.runtime?.visibleUserMessage === "steer-drain-msg");
    expect(steerRan).toBe(true);
  });

  test("interrupt 模式运行中提交应中止当前 turn 且不进入 errored", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { appendAgentMessage } = await import("./agent-service");
    const { getAgentRuntimeStatusManager } = await import("./agent-runtime-status-manager");
    const thread = createAgentThread("interrupt-route", "channel-test");
    const createEmit = () => ({
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "hold:active",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, createEmit());
    // 等 mock runtime session 进入 active,模拟"运行中提交"窗口
    await waitForMockSessionActive(thread.id);

    appendAgentMessage({
      threadId: thread.id,
      userMessage: "中断后重发",
      channelId: "channel-test",
      modelId: "provider/model-test",
      followUpQueueMode: "interrupt"
    }, createEmit());

    await waitForQueuedRunRelease("hold:active");
    // interrupt 触发的中止是正常路径,不应让线程进入 errored
    expect(getAgentRuntimeStatusManager().get(thread.id)?.phase).not.toBe("errored");
  });
});
