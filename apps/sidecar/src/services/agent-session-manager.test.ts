import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendAgentTranscriptMessage,
  createAgentSession,
  deleteAgentSession,
  getAgentSessionMeta,
  getAgentSessionMessages,
  getRecentAgentMessages,
  migrateChatToAgentSession,
  moveAgentSessionToWorkspace,
  truncateAgentMessagesFrom,
  updateAgentSessionMeta,
  toggleAgentSessionPin
} from "./agent-session-manager";
import { createAgentWorkspace } from "./agent-workspace-manager";
import { getAgentWorkspacePath } from "./config-paths";
import { appendMessage, createConversation } from "./conversation-manager";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDirPath
} from "./pi-agent/runtime-core/session-store";

describe("agent-session-manager advanced ops", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-session-manager-"));
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

  test("toggleAgentSessionPin 应可在置顶和取消置顶之间切换", () => {
    const created = createAgentSession("测试会话");
    const pinned = toggleAgentSessionPin(created.id);

    expect(pinned.pinned).toBeTrue();
    expect(getAgentSessionMeta(created.id)?.pinned).toBeTrue();

    const unpinned = toggleAgentSessionPin(created.id);
    expect(unpinned.pinned).toBeFalse();
    expect(getAgentSessionMeta(created.id)?.pinned).toBeFalse();
  });

  test("createAgentSession 应保存 channelId 和 modelId", () => {
    const created = createAgentSession("模型会话", "channel-1", undefined, undefined, "provider/model-1");

    expect(created.channelId).toBe("channel-1");
    expect(created.modelId).toBe("provider/model-1");
    expect(getAgentSessionMeta(created.id)?.modelId).toBe("provider/model-1");
  });

  test("moveAgentSessionToWorkspace 应迁移 session 工作目录并更新 workspaceId", () => {
    const sourceWorkspace = createAgentWorkspace("源工作区");
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentSession("迁移会话", undefined, sourceWorkspace.id);

    const sourceSessionDir = join(getAgentWorkspacePath(sourceWorkspace.slug), created.id);
    const targetSessionDir = join(getAgentWorkspacePath(targetWorkspace.slug), created.id);
    writeFileSync(join(sourceSessionDir, "note.txt"), "hello", "utf-8");
    updateAgentSessionMeta(created.id, {
      sdkSessionId: "sdk-session",
      piSessionId: "pi-session"
    });

    const moved = moveAgentSessionToWorkspace(created.id, targetWorkspace.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(moved.sdkSessionId).toBeUndefined();
    expect(moved.piSessionId).toBeUndefined();
    expect(existsSync(sourceSessionDir)).toBeFalse();
    expect(existsSync(targetSessionDir)).toBeTrue();
    expect(readFileSync(join(targetSessionDir, "note.txt"), "utf-8")).toBe("hello");
  });

  test("moveAgentSessionToWorkspace 在无源工作目录时也应创建目标目录", () => {
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentSession("新会话");

    const moved = moveAgentSessionToWorkspace(created.id, targetWorkspace.id);
    const targetSessionDir = join(getAgentWorkspacePath(targetWorkspace.slug), created.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(existsSync(targetSessionDir)).toBeTrue();
    expect(getAgentSessionMeta(created.id)?.workspaceId).toBe(targetWorkspace.id);
  });

  test("moveAgentSessionToWorkspace 当目标目录已存在时应以源目录覆盖", () => {
    const sourceWorkspace = createAgentWorkspace("源工作区");
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentSession("覆盖迁移会话", undefined, sourceWorkspace.id);

    const sourceSessionDir = join(getAgentWorkspacePath(sourceWorkspace.slug), created.id);
    const targetSessionDir = join(getAgentWorkspacePath(targetWorkspace.slug), created.id);
    writeFileSync(join(sourceSessionDir, "source.txt"), "source", "utf-8");
    mkdirSync(targetSessionDir, { recursive: true });
    writeFileSync(join(targetSessionDir, "target.txt"), "target", "utf-8");

    const moved = moveAgentSessionToWorkspace(created.id, targetWorkspace.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(existsSync(join(targetSessionDir, "source.txt"))).toBeTrue();
    expect(existsSync(join(targetSessionDir, "target.txt"))).toBeFalse();
    expect(existsSync(sourceSessionDir)).toBeFalse();
  });

  test("migrateChatToAgentSession 应迁移 user/assistant 文本消息", () => {
    const conversation = createConversation("聊天记录");
    appendMessage(conversation.id, {
      id: "msg-user",
      role: "user",
      content: "你好",
      createdAt: 1
    });
    appendMessage(conversation.id, {
      id: "msg-assistant",
      role: "assistant",
      content: "我在",
      createdAt: 2,
      model: "demo-model"
    });
    appendMessage(conversation.id, {
      id: "msg-system",
      role: "system",
      content: "ignore me",
      createdAt: 3
    });

    const session = createAgentSession("目标会话");
    const migrated = migrateChatToAgentSession(conversation.id, session.id);
    const messages = getAgentSessionMessages(session.id);

    expect(migrated).toBe(2);
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("你好");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toBe("我在");
    expect(messages[1]?.model).toBe("unknown/demo-model");
  });

  test("JSONL 缺失时应回退到 runtime-core transcript 消息", () => {
    const session = createAgentSession("runtime-core fallback");
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

    const messages = getAgentSessionMessages(session.id);
    const recent = getRecentAgentMessages(session.id, 1);

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

  test("transcript 存在时应按 transcript 主消息读取", () => {
    const session = createAgentSession("transcript first");

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

    const messages = getAgentSessionMessages(session.id);
    expect(messages.length).toBe(2);
    expect(messages[0]?.content).toBe("来自 transcript 的新消息");
    expect(messages[1]?.content).toBe("transcript assistant");
  });

  test("deleteAgentSession 应清理 runtime-core transcript 目录", () => {
    const session = createAgentSession("delete transcript");
    appendAgentTranscriptMessage(session.id, {
      id: "announce-delete",
      role: "assistant",
      content: "子任务完成通知: delete transcript (completed)\nrunId: run-delete\nchildSessionKey: child-delete",
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

    deleteAgentSession(session.id);

    expect(existsSync(runtimeCoreSessionDir)).toBeFalse();
  });

  test("truncateAgentMessagesFrom 应直接重建裁剪后的 transcript", () => {
    const session = createAgentSession("truncate transcript");
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

    const messagesBefore = getAgentSessionMessages(session.id);
    const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(session.id);
    const kept = truncateAgentMessagesFrom(session.id, messagesBefore[2]!.id);
    const messagesAfter = getAgentSessionMessages(session.id);

    expect(kept.length).toBe(2);
    expect(existsSync(runtimeCoreSessionDir)).toBeTrue();
    expect(messagesAfter.length).toBe(2);
    expect(messagesAfter[0]?.content).toBe("第一条");
    expect(messagesAfter[1]?.content).toBe("第二条");
    expect(getAgentSessionMeta(session.id)?.piSessionId).toBeUndefined();
  });
});
