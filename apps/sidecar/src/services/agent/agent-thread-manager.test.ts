import { registerRealAgentStores } from "../agent-runtime/agent-thread-store-test-adapter";
registerRealAgentStores();
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMessage } from "@lume/shared";
import {
  appendAgentTranscriptMessage,
  appendAgentThreadSDKMessages,
  clearAgentThreadMessages,
  createAgentThread,
  deleteAgentThread,
  forkAgentThread,
  getAgentThreadMeta,
  getAgentThreadMessages,
  getAgentThreadSDKMessages,
  getRecentAgentThreadMessages,
  moveAgentThreadToWorkspace,
  truncateAgentMessagesFrom,
  tryUpdateAgentThreadMeta,
  updateAgentThreadMeta,
  toggleAgentThreadPin,
  trashAgentThread,
  archiveAgentThread,
  emptyTrash,
  listAgentThreads,
  listTrashedThreads
} from "./agent-thread-manager";
import { createAgentWorkspace } from "./agent-workspace-manager";
import { resolveAgentThreadWorkdir } from "../agent-runtime/agent-workdir-resolver";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDirPath
} from "../agent-runtime/runtime-core/session-store";
import { getAgentMessageVersionStorePath, readAgentMessageVersionStore } from "./agent-message-version-store";
import { resetAgentSubmissionStoreForTests } from "./agent-submission-store";
import { resetPlanningTodoStoreForTests } from "../planning/planning-todo-store";

describe("agent-thread-manager advanced ops", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-thread-manager-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    resetAgentSubmissionStoreForTests();
    resetPlanningTodoStoreForTests();
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

  function projectPath(name: string): string {
    const path = join(tempConfigDir, "projects", name);
    mkdirSync(path, { recursive: true });
    return path;
  }

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
    const workspace = createAgentWorkspace("结构工作区", { projectPath: projectPath("structure") });
    const created = createAgentThread("结构线程", undefined, workspace.id);

    const resolved = resolveAgentThreadWorkdir(created.id);
    const threadRoot = resolved.lumeWorkDir;

    expect(existsSync(threadRoot)).toBeTrue();
    expect(resolved.agentCwd).toBe(workspace.projectPath!);
    expect(existsSync(resolved.filesRoot)).toBeTrue();
    expect(existsSync(resolved.plansRoot)).toBeTrue();
    expect(existsSync(resolved.artifactsRoot)).toBeTrue();
    expect(existsSync(join(threadRoot, ".context"))).toBeTrue();
    expect(existsSync(join(threadRoot, ".claude"))).toBeFalse();
  });

  test("resolveAgentThreadWorkdir 应惰性迁移旧线程工作目录", () => {
    const workspace = createAgentWorkspace("旧项目", { projectPath: projectPath("legacy") });
    const created = createAgentThread("旧线程", undefined, workspace.id);
    const legacyRoot = join(tempConfigDir, "agent-workspaces", workspace.slug, "threads", created.id);
    const legacyFiles = join(legacyRoot, "files");
    mkdirSync(legacyFiles, { recursive: true });
    writeFileSync(join(legacyFiles, "legacy.txt"), "legacy", "utf-8");

    const resolved = resolveAgentThreadWorkdir(created.id);

    expect(readFileSync(join(resolved.filesRoot, "legacy.txt"), "utf-8")).toBe("legacy");
    expect(existsSync(join(resolved.lumeWorkDir, ".migration-v1.json"))).toBeTrue();
    expect(existsSync(legacyRoot)).toBeFalse();
  });
  test("moveAgentThreadToWorkspace 应保留 file context 并更新 workspaceId", () => {
    const sourceWorkspace = createAgentWorkspace("源工作区", { projectPath: projectPath("source") });
    const targetWorkspace = createAgentWorkspace("目标工作区", { projectPath: projectPath("target") });
    const created = createAgentThread("迁移会话", undefined, sourceWorkspace.id);

    const sourceWorkdir = resolveAgentThreadWorkdir(created.id);
    writeFileSync(join(sourceWorkdir.lumeWorkDir, "note.txt"), "hello", "utf-8");
    updateAgentThreadMeta(created.id, {
      sdkThreadId: "sdk-session",
      runtimeThreadId: "pi-session"
    });

    const moved = moveAgentThreadToWorkspace(created.id, targetWorkspace.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(moved.sdkThreadId).toBeUndefined();
    expect(moved.runtimeThreadId).toBeUndefined();
    const movedWorkdir = resolveAgentThreadWorkdir(created.id);
    expect(movedWorkdir.fileContextId).toBe(sourceWorkdir.fileContextId);
    expect(movedWorkdir.lumeWorkDir).toBe(sourceWorkdir.lumeWorkDir);
    expect(movedWorkdir.agentCwd).toBe(targetWorkspace.projectPath!);
    expect(readFileSync(join(movedWorkdir.lumeWorkDir, "note.txt"), "utf-8")).toBe("hello");
  });

  test("moveAgentThreadToWorkspace 在无源工作目录时也应确保 file context 可用", () => {
    const targetWorkspace = createAgentWorkspace("目标工作区", { projectPath: projectPath("empty-target") });
    const created = createAgentThread("新会话");

    const moved = moveAgentThreadToWorkspace(created.id, targetWorkspace.id);
    const movedWorkdir = resolveAgentThreadWorkdir(created.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(existsSync(movedWorkdir.lumeWorkDir)).toBeTrue();
    expect(movedWorkdir.agentCwd).toBe(targetWorkspace.projectPath!);
    expect(getAgentThreadMeta(created.id)?.workspaceId).toBe(targetWorkspace.id);
  });

  test("moveAgentThreadToWorkspace 不应覆盖既有 file context 文件", () => {
    const sourceWorkspace = createAgentWorkspace("源工作区", { projectPath: projectPath("overwrite-source") });
    const targetWorkspace = createAgentWorkspace("目标工作区", { projectPath: projectPath("overwrite-target") });
    const created = createAgentThread("覆盖迁移会话", undefined, sourceWorkspace.id);

    const workdir = resolveAgentThreadWorkdir(created.id);
    writeFileSync(join(workdir.lumeWorkDir, "source.txt"), "source", "utf-8");
    writeFileSync(join(workdir.lumeWorkDir, "target.txt"), "target", "utf-8");

    const moved = moveAgentThreadToWorkspace(created.id, targetWorkspace.id);
    const movedWorkdir = resolveAgentThreadWorkdir(created.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(movedWorkdir.lumeWorkDir).toBe(workdir.lumeWorkDir);
    expect(existsSync(join(movedWorkdir.lumeWorkDir, "source.txt"))).toBeTrue();
    expect(existsSync(join(movedWorkdir.lumeWorkDir, "target.txt"))).toBeTrue();
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

    const deletedThreadIds = emptyTrash();

    expect(deletedThreadIds).toHaveLength(2);
    expect(deletedThreadIds).toContain(trashed1.id);
    expect(deletedThreadIds).toContain(trashed2.id);
    expect(listTrashedThreads()).toHaveLength(0);

    // 已 trash 线程应从索引中彻底移除
    expect(getAgentThreadMeta(trashed1.id)).toBeUndefined();
    expect(getAgentThreadMeta(trashed2.id)).toBeUndefined();

    // active / archived 线程应存活且状态不变
    expect(getAgentThreadMeta(activeThread.id)?.status).not.toBe("trashed");
    expect(getAgentThreadMeta(archivedThread.id)?.status).toBe("archived");
    expect(listAgentThreads().map((t) => t.id)).toContain(activeThread.id);
  });

  test("emptyTrash 在回收站为空时应返回空列表", () => {
    const active = createAgentThread("仅活跃");

    expect(listTrashedThreads()).toHaveLength(0);
    expect(emptyTrash()).toEqual([]);
    expect(getAgentThreadMeta(active.id)).toBeDefined();
  });

  test("tryUpdateAgentThreadMeta 对不存在的线程返回 null 而非抛出", () => {
    const created = createAgentThread("在线程");
    const updated = tryUpdateAgentThreadMeta(created.id, { title: "新标题" });
    expect(updated).not.toBeNull();
    expect(updated?.title).toBe("新标题");
    expect(getAgentThreadMeta(created.id)?.title).toBe("新标题");

    // 索引条目缺失时返回 null，不抛出：标题/模型选择等非关键写入不应让整次运行失败
    expect(tryUpdateAgentThreadMeta("nonexistent-thread-id", { title: "x" })).toBeNull();
  });

  test("updateAgentThreadMeta 对不存在的线程仍抛出（契约不变）", () => {
    expect(() => updateAgentThreadMeta("nonexistent-thread-id", { title: "x" })).toThrow(
      "Agent 线程不存在"
    );
  });

  test("归档父会话时应级联归档其委托子会话（parentThreadId）", () => {
    const parent = createAgentThread("父会话", undefined, "ws-1");
    const child = createAgentThread("子会话", undefined, "ws-1", parent.id);

    archiveAgentThread(parent.id);

    // 父会话被归档后从 active 列表中消失
    expect(listAgentThreads().find((t) => t.id === parent.id)).toBeUndefined();
    // D8: 委托子会话也应被级联归档，不再出现在 active 列表
    expect(listAgentThreads().find((t) => t.id === child.id)).toBeUndefined();
  });
});

describe("clearAgentThreadMessages", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-clear-thread-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (oldConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = oldConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  const buildMessage = (role: "user" | "assistant", content: string): AgentMessage =>
    ({ id: `${role}-${content}`, role, content, createdAt: Date.now() }) as AgentMessage;

  it("清空全部消息且保留 thread 本身", async () => {
    const thread = createAgentThread("测试会话");
    appendAgentTranscriptMessage(thread.id, buildMessage("user", "你好"));
    appendAgentTranscriptMessage(thread.id, buildMessage("assistant", "你好，有什么可以帮你"));
    expect(getAgentThreadMessages(thread.id).length).toBe(2);

    const result = await clearAgentThreadMessages(thread.id);

    expect(result.ok).toBe(true);
    expect(result.cleared).toBe(2);
    expect(getAgentThreadMessages(thread.id).length).toBe(0);
    expect(getAgentThreadMeta(thread.id)).toBeDefined();
  });

  it("空 thread 清空幂等无害", async () => {
    const thread = createAgentThread("空会话");
    const result = await clearAgentThreadMessages(thread.id);
    expect(result.ok).toBe(true);
    expect(result.cleared).toBe(0);
    expect(getAgentThreadMessages(thread.id).length).toBe(0);
    expect(getAgentThreadMeta(thread.id)).toBeDefined();
  });
});
