import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendAgentTranscriptMessage,
  appendAgentThreadSDKMessages,
  createAgentThread,
  deleteAgentThread,
  forkAgentThread,
  getAgentThreadMeta,
  getAgentThreadMessages,
  getAgentThreadSDKMessages,
  getRecentAgentThreadMessages,
  moveAgentThreadToWorkspace,
  truncateAgentMessagesFrom,
  updateAgentThreadMeta,
  toggleAgentThreadPin,
  trashAgentThread,
  archiveAgentThread,
  emptyTrash,
  listAgentThreads,
  listTrashedThreads
} from "./agent-thread-manager";
import { createAgentWorkspace } from "./agent-workspace-manager";
import { getAgentThreadArtifactsPath, getAgentThreadFilesPath, getAgentThreadPlansPath, getAgentThreadRootPath, getAgentWorkspacePath } from "../infra/config-paths";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDirPath
} from "../agent-runtime/runtime-core/session-store";
import { getAgentMessageVersionStorePath, readAgentMessageVersionStore } from "./agent-message-version-store";

describe("agent-thread-manager advanced ops", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-thread-manager-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
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

  test("toggleAgentThreadPin 应可在置顶和取消置顶之间切换", () => {
    const created = createAgentThread("测试会话");
    const pinned = toggleAgentThreadPin(created.id);

    expect(pinned.pinned).toBeTrue();
    expect(getAgentThreadMeta(created.id)?.pinned).toBeTrue();

    const unpinned = toggleAgentThreadPin(created.id);
    expect(unpinned.pinned).toBeFalse();
    expect(getAgentThreadMeta(created.id)?.pinned).toBeFalse();
  });

  test("createAgentThread 应保存 channelId 和 modelId", () => {
    const created = createAgentThread("模型会话", "channel-1", undefined, undefined, "provider/model-1");

    expect(created.channelId).toBe("channel-1");
    expect(created.modelId).toBe("provider/model-1");
    expect(created.modelRef).toBe("provider/model-1");
    expect(getAgentThreadMeta(created.id)?.modelId).toBe("provider/model-1");
    expect(getAgentThreadMeta(created.id)?.modelRef).toBe("provider/model-1");
  });

  test("createAgentThread 应创建 files plans artifacts 与 .context 子目录，且不再创建 .claude", () => {
    const workspace = createAgentWorkspace("结构工作区");
    const created = createAgentThread("结构线程", undefined, workspace.id);

    const threadRoot = getAgentThreadRootPath(workspace.slug, created.id);

    expect(existsSync(threadRoot)).toBeTrue();
    expect(existsSync(getAgentThreadFilesPath(workspace.slug, created.id))).toBeTrue();
    expect(existsSync(getAgentThreadPlansPath(workspace.slug, created.id))).toBeTrue();
    expect(existsSync(getAgentThreadArtifactsPath(workspace.slug, created.id))).toBeTrue();
    expect(existsSync(join(threadRoot, ".context"))).toBeTrue();
    expect(existsSync(join(threadRoot, ".claude"))).toBeFalse();
  });

  test("moveAgentThreadToWorkspace 应迁移 session 工作目录并更新 workspaceId", () => {
    const sourceWorkspace = createAgentWorkspace("源工作区");
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentThread("迁移会话", undefined, sourceWorkspace.id);

    const sourceSessionDir = getAgentThreadRootPath(sourceWorkspace.slug, created.id);
    const targetSessionDir = getAgentThreadRootPath(targetWorkspace.slug, created.id);
    writeFileSync(join(sourceSessionDir, "note.txt"), "hello", "utf-8");
    updateAgentThreadMeta(created.id, {
      sdkThreadId: "sdk-session",
      runtimeThreadId: "pi-session"
    });

    const moved = moveAgentThreadToWorkspace(created.id, targetWorkspace.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(moved.sdkThreadId).toBeUndefined();
    expect(moved.runtimeThreadId).toBeUndefined();
    expect(existsSync(sourceSessionDir)).toBeFalse();
    expect(existsSync(targetSessionDir)).toBeTrue();
    expect(readFileSync(join(targetSessionDir, "note.txt"), "utf-8")).toBe("hello");
  });

  test("moveAgentThreadToWorkspace 在无源工作目录时也应创建目标目录", () => {
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentThread("新会话");

    const moved = moveAgentThreadToWorkspace(created.id, targetWorkspace.id);
    const targetSessionDir = getAgentThreadRootPath(targetWorkspace.slug, created.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(existsSync(targetSessionDir)).toBeTrue();
    expect(getAgentThreadMeta(created.id)?.workspaceId).toBe(targetWorkspace.id);
  });

  test("moveAgentThreadToWorkspace 当目标目录已存在时应以源目录覆盖", () => {
    const sourceWorkspace = createAgentWorkspace("源工作区");
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentThread("覆盖迁移会话", undefined, sourceWorkspace.id);

    const sourceSessionDir = getAgentThreadRootPath(sourceWorkspace.slug, created.id);
    const targetSessionDir = getAgentThreadRootPath(targetWorkspace.slug, created.id);
    writeFileSync(join(sourceSessionDir, "source.txt"), "source", "utf-8");
    mkdirSync(targetSessionDir, { recursive: true });
    writeFileSync(join(targetSessionDir, "target.txt"), "target", "utf-8");

    const moved = moveAgentThreadToWorkspace(created.id, targetWorkspace.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(existsSync(join(targetSessionDir, "source.txt"))).toBeTrue();
    expect(existsSync(join(targetSessionDir, "target.txt"))).toBeFalse();
    expect(existsSync(sourceSessionDir)).toBeFalse();
  });

  test("JSONL 缺失时应回退到 runtime-core transcript 消息", () => {
    const session = createAgentThread("runtime-core fallback");
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), session.id);

    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "来自 transcript 的用户消息" }],
      timestamp: 11
    });
    sessionManager.appendMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: "来自 transcript 的助手消息" }],
      timestamp: 22
    });

    const messages = getAgentThreadMessages(session.id);
    const recent = getRecentAgentThreadMessages(session.id, 1);

    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("来自 transcript 的用户消息");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toBe("来自 transcript 的助手消息");
    expect(messages[1]?.model).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(recent.total).toBe(2);
    expect(recent.hasMore).toBeTrue();
    expect(recent.messages[0]?.content).toBe("来自 transcript 的助手消息");
  });

  test("appendAgentThreadSDKMessages / getAgentThreadSDKMessages 应持久化原始 SDKMessage", () => {
    const session = createAgentThread("sdk transcript");
    appendAgentThreadSDKMessages(session.id, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "assistant raw" }]
        }
      } as any,
      {
        type: "result",
        subtype: "success",
        duration_ms: 12
      } as any
    ]);

    const sdkMessages = getAgentThreadSDKMessages(session.id);
    expect(sdkMessages).toHaveLength(2);
    expect(sdkMessages[0]?.type).toBe("assistant");
    expect((sdkMessages[0] as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text).toBe("assistant raw");
    expect(sdkMessages[1]?.type).toBe("result");
  });

  test("transcript 回放应分离 reasoning 与正式正文", () => {
    const session = createAgentThread("reasoning transcript");
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), session.id);

    sessionManager.appendMessage({
      role: "assistant",
      provider: "zai",
      model: "glm-5-turbo",
      api: "openai-completions",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [
        { type: "thinking", thinking: "先读取工作区文件" },
        { type: "text", text: "这是正式回答" }
      ],
      timestamp: 33
    });

    const messages = getAgentThreadMessages(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("这是正式回答");
    expect(messages[0]?.reasoning).toBe("先读取工作区文件");
  });

  test("transcript 存在时应按 transcript 主消息读取", () => {
    const session = createAgentThread("transcript first");

    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), session.id);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "来自 transcript 的新消息" }],
      timestamp: 2
    });
    sessionManager.appendMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: "transcript assistant" }],
      timestamp: 3
    });

    const messages = getAgentThreadMessages(session.id);
    expect(messages.length).toBe(2);
    expect(messages[0]?.content).toBe("来自 transcript 的新消息");
    expect(messages[1]?.content).toBe("transcript assistant");
  });

  test("getAgentThreadMessages 应自动初始化消息版本 store", () => {
    const session = createAgentThread("version store init");
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), session.id);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "来自 transcript 的版本消息" }],
      timestamp: 1
    });

    const messages = getAgentThreadMessages(session.id);
    const store = readAgentMessageVersionStore(session.id);

    expect(existsSync(getAgentMessageVersionStorePath(session.id))).toBeTrue();
    expect(messages[0]?.versionIndex).toBe(1);
    expect(messages[0]?.versionCount).toBe(1);
    expect(messages[0]?.isLatestVersion).toBeTrue();
    expect(store?.messages.length).toBe(1);
  });

  test("deleteAgentThread 应清理 runtime-core transcript 目录", () => {
    const session = createAgentThread("delete transcript");
    appendAgentTranscriptMessage(session.id, {
      id: "announce-delete",
      role: "assistant",
      content: "子任务完成通知: delete transcript (completed)\nrunId: run-delete\nchildThreadId: child-delete",
      createdAt: 1,
      model: "subagent/announce"
    });
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), session.id);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "transcript user" }],
      timestamp: 2
    });
    sessionManager.appendMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: "transcript assistant" }],
      timestamp: 3
    });

    const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(session.id);
    expect(existsSync(runtimeCoreSessionDir)).toBeTrue();

    deleteAgentThread(session.id);

    expect(existsSync(runtimeCoreSessionDir)).toBeFalse();
  });

  test("truncateAgentMessagesFrom 应直接重建裁剪后的 transcript", () => {
    const session = createAgentThread("truncate transcript");
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), session.id);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "第一条" }],
      timestamp: 1
    });
    sessionManager.appendMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: "第二条" }],
      timestamp: 2
    });
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "第三条" }],
      timestamp: 3
    });

    const messagesBefore = getAgentThreadMessages(session.id);
    const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(session.id);
    const kept = truncateAgentMessagesFrom(session.id, messagesBefore[2]!.id);
    const messagesAfter = getAgentThreadMessages(session.id);

    expect(kept.length).toBe(2);
    expect(existsSync(runtimeCoreSessionDir)).toBeTrue();
    expect(messagesAfter.length).toBe(2);
    expect(messagesAfter[0]?.content).toBe("第一条");
    expect(messagesAfter[1]?.content).toBe("第二条");
    expect(getAgentThreadMeta(session.id)?.runtimeThreadId).toBeUndefined();
  });

  test("forkAgentThread 应同时重建 raw SDK transcript", () => {
    const session = createAgentThread("fork sdk transcript");
    appendAgentThreadSDKMessages(session.id, [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "原始用户消息" }]
        }
      } as any,
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "原始助手消息" }]
        }
      } as any
    ]);
    appendAgentTranscriptMessage(session.id, {
      id: "u1",
      role: "user",
      content: "原始用户消息",
      createdAt: 1
    });
    appendAgentTranscriptMessage(session.id, {
      id: "a1",
      role: "assistant",
      content: "原始助手消息",
      createdAt: 2,
      sdkMessages: [{
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "原始助手消息" }]
        }
      } as any]
    });

    const visibleMessages = getAgentThreadMessages(session.id);
    const assistantMessageId = visibleMessages.find((message) => message.role === "assistant")?.id;
    expect(typeof assistantMessageId).toBe("string");
    const result = forkAgentThread(session.id, assistantMessageId as string);
    const forkedSdkMessages = getAgentThreadSDKMessages(result.newThreadId);

    expect(forkedSdkMessages.length).toBeGreaterThan(0);
    expect(forkedSdkMessages.some((message) => message.type === "assistant")).toBeTrue();
  });

  test("emptyTrash 应永久删除全部已 trash 线程，并保留 active/archived 线程", () => {
    const activeThread = createAgentThread("活跃线程");
    const archivedThread = createAgentThread("归档线程");
    const trashed1 = createAgentThread("回收站线程1");
    const trashed2 = createAgentThread("回收站线程2");

    archiveAgentThread(archivedThread.id);
    trashAgentThread(trashed1.id);
    trashAgentThread(trashed2.id);

    expect(listTrashedThreads()).toHaveLength(2);

    const cleanedCount = emptyTrash();

    expect(cleanedCount).toBe(2);
    expect(listTrashedThreads()).toHaveLength(0);

    // 已 trash 线程应从索引中彻底移除
    expect(getAgentThreadMeta(trashed1.id)).toBeUndefined();
    expect(getAgentThreadMeta(trashed2.id)).toBeUndefined();

    // active / archived 线程应存活且状态不变
    expect(getAgentThreadMeta(activeThread.id)?.status).not.toBe("trashed");
    expect(getAgentThreadMeta(archivedThread.id)?.status).toBe("archived");
    expect(listAgentThreads().map((t) => t.id)).toContain(activeThread.id);
  });

  test("emptyTrash 在回收站为空时应返回 0", () => {
    const active = createAgentThread("仅活跃");

    expect(listTrashedThreads()).toHaveLength(0);
    expect(emptyTrash()).toBe(0);
    expect(getAgentThreadMeta(active.id)).toBeDefined();
  });
});
