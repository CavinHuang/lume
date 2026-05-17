import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMessageAppendedEvent, SDKMessage } from "@lume/shared";

const heldRunResolvers = new Map<string, () => void>();
const runAgentRuntimeCalls: unknown[] = [];

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
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
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

mock.module("../../providers", () => ({
  fetchTitle: async () => null,
  getAdapter: () => ({
    buildTitleRequest: () => ({})
  })
}));

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
    if (userMessage === "subagent-projection") {
      emitRunWithSubagentTranscript(emit);
      return { status: "completed" as const };
    }
    if (userMessage === "compact-summary") {
      emitRunWithCompactionSummary(emit);
      return { status: "completed" as const };
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
  },
  stopAgentRuntime: () => undefined
}));

describe("agent-service", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-service-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(async () => {
    const { resetAgentRuntimeStatusManagerForTest } = await import("./agent-runtime-status-manager");
    const { resetAgentRuntimeKernelForTest, waitForAgentRuntimeKernelIdleForTest } = await import("./agent-service");
    const { closeMemoryManagers } = await import("../memory/memory-service");
    const { drainServiceRuntimeForTest, resetServiceRuntimeForTest } = await import("../agent-runtime/service-runtime/service-runtime");
    await waitForAgentRuntimeKernelIdleForTest();
    await drainServiceRuntimeForTest();
    resetAgentRuntimeStatusManagerForTest();
    resetAgentRuntimeKernelForTest();
    resetServiceRuntimeForTest();
    closeMemoryManagers();
    heldRunResolvers.clear();
    runAgentRuntimeCalls.length = 0;
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

    expect(visibleMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(visibleMessages[0]?.sdkMessages?.[0]?.type).toBe("user");
    expect(visibleMessages[1]?.content).toBe("mock assistant output");
    expect(sdkMessages.map((message) => message.type)).toEqual(["user", "assistant", "result"]);
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

  test("sendAgentMessage 应继承线程工作区传给 runtime", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { createAgentWorkspace } = await import("./agent-workspace-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const workspace = createAgentWorkspace("Runtime Workspace", { slug: "runtime-workspace" });
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
      onToolPermissionRequest: () => undefined
    });

    expect((runAgentRuntimeCalls.at(-1) as { runtime?: { workspaceId?: string } })?.runtime?.workspaceId).toBe(workspace.id);
  });

  test("sendAgentMessage 在 compaction boundary 后写入结构化 memory flush", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { createAgentWorkspace } = await import("./agent-workspace-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const { drainServiceRuntimeForTest } = await import("../agent-runtime/service-runtime/service-runtime");
    const { searchLayeredMemory } = await import("../memory/memory-service");
    const workspace = createAgentWorkspace("Memory Flush Workspace", { slug: "memory-flush-workspace" });
    const thread = createAgentThread("compaction memory flush", "channel-test", workspace.id);

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "compact-summary",
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

    await drainServiceRuntimeForTest();

    const results = await searchLayeredMemory({
      workspaceSlug: workspace.slug,
      query: "structured memory flush compaction summaries",
      maxResults: 5,
      includeGlobal: false
    });

    expect(results[0]).toEqual(expect.objectContaining({
      kind: "episode",
      scope: "workspace",
      source: "flush"
    }));
    expect(results[0]?.snippet).toContain("structured memory flush");
  });

  test("appendAgentMessage 应在运行中排队并在完成后自动发送下一条", async () => {
    const { createAgentThread } = await import("./agent-thread-manager");
    const { appendAgentMessage } = await import("./agent-service");
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
    expect(getAgentRuntimeStatusManager().get(thread.id)?.queuedCount).toBe(1);

    await waitForQueuedRunRelease("hold:first");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(getAgentRuntimeStatusManager().get(thread.id)?.queuedCount).toBe(0);
    expect(appended.filter((event) => event.message.role === "user").map((event) => event.message.content)).toEqual([
      "hold:first",
      "second"
    ]);
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
      onToolPermissionRequest: () => undefined
    });

    const visibleMessages = getAgentThreadMessages(thread.id);

    expect(events.errors).toEqual([]);
    expect(events.completed).toBe(1);
    expect(visibleMessages.some((message) => message.metadata?.subagentAnnounce === true)).toBe(false);
    expect(visibleMessages.some((message) => message.role === "assistant" && message.content === "mock assistant output")).toBe(true);
  });
});
