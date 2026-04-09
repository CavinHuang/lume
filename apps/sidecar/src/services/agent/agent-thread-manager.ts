/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-thread-manager.ts
 * Adaptation:
 * - Shared imports updated to `@lume/shared`.
 * - Config root and paths are resolved by sidecar `config-paths` (`~/.lume`).
 */

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentMessage, AgentRecentMessagesResult, AgentThreadMeta, SDKMessage } from "@lume/shared";
import {
  getAgentSessionDataDir,
  getAgentThreadMessagesPath,
  getAgentWorkspacesDir,
  getAgentWorkspacePath,
  getAgentSessionWorkspacePath,
  getAgentSessionsIndexPath
} from "../infra/config-paths";
import { ensureWorkspaceAgentAssets, getAgentWorkspace } from "./agent-workspace-manager";
import {
  getVisibleAgentMessages,
  syncVersionStoreFromMessages
} from "./agent-message-versioning-service";
import { readAgentMessageVersionStore, resetAgentMessageVersionStore } from "./agent-message-version-store";
import { getConversationMessages } from "../chat/conversation-manager";
import { extractAssistantReasoningText, extractRenderableAssistantText } from "../pi-agent/content-extraction";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDirPath,
  hasRuntimeCoreSessionTranscript
} from "../pi-agent/runtime-core/session-store";

interface AgentThreadsIndex {
  version: number;
  threads: AgentThreadMeta[];
}

const INDEX_VERSION = 1;

interface RuntimeCoreContextMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function backupCorruptFile(filePath: string, label: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, backupPath);
    console.warn(`[${label}] 检测到损坏文件，已备份: ${backupPath}`);
  } catch (error) {
    console.warn(`[${label}] 备份损坏文件失败:`, error);
  }
}

function readIndex(): AgentThreadsIndex {
  const indexPath = getAgentSessionsIndexPath();
  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, threads: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as
      | AgentThreadsIndex
      | { version?: number; sessions?: AgentThreadMeta[] };
    if (Array.isArray((parsed as AgentThreadsIndex).threads)) {
      return {
        version: typeof parsed.version === "number" ? parsed.version : INDEX_VERSION,
        threads: (parsed as AgentThreadsIndex).threads
      };
    }
    return {
      version: typeof parsed.version === "number" ? parsed.version : INDEX_VERSION,
      threads: Array.isArray((parsed as { sessions?: AgentThreadMeta[] }).sessions)
        ? (parsed as { sessions: AgentThreadMeta[] }).sessions
        : []
    };
  } catch (error) {
    console.error("[Agent 线程] 读取索引文件失败:", error);
    backupCorruptFile(indexPath, "Agent 线程");
    return { version: INDEX_VERSION, threads: [] };
  }
}

function writeIndex(index: AgentThreadsIndex): void {
  const indexPath = getAgentSessionsIndexPath();
  try {
    writeTextAtomic(indexPath, JSON.stringify(index, null, 2));
  } catch (error) {
    console.error("[Agent 线程] 写入索引文件失败:", error);
    throw new Error("写入 Agent 线程索引失败");
  }
}

export function listAgentThreads(): AgentThreadMeta[] {
  return readIndex().threads.sort((a, b) => b.updatedAt - a.updatedAt);
}
export const listAgentSessions = listAgentThreads;

export function getAgentThreadMeta(id: string): AgentThreadMeta | undefined {
  return readIndex().threads.find((thread) => thread.id === id);
}
export const getAgentSessionMeta = getAgentThreadMeta;


export function createAgentThread(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  parentThreadId?: string,
  modelId?: string
): AgentThreadMeta {
  const index = readIndex();
  const now = Date.now();

  const meta: AgentThreadMeta = {
    id: randomUUID(),
    title: title || "新 Agent 线程",
    channelId,
    modelId,
    workspaceId,
    parentThreadId,
    pinned: false,
    createdAt: now,
    updatedAt: now
  };

  index.threads.push(meta);
  writeIndex(index);

  if (workspaceId) {
    const workspace = getAgentWorkspace(workspaceId);
    if (workspace) {
      ensureWorkspaceAgentAssets(workspace.slug, workspace.name);
      getAgentSessionWorkspacePath(workspace.slug, meta.id);
    }
  }

  console.log(`[Agent 线程] 已创建线程: ${meta.title} (${meta.id})`);
  return meta;
}
export const createAgentSession = createAgentThread;

export function getAgentThreadMessages(id: string): AgentMessage[] {
  const existingStore = readAgentMessageVersionStore(id);
  if (existingStore && existingStore.visibleGroupIds.length > 0) {
    return getVisibleAgentMessages(id);
  }
  const transcriptMessages = readRuntimeCoreTranscriptMessages(id);
  syncVersionStoreFromMessages(id, transcriptMessages);
  return getVisibleAgentMessages(id);
}
export const getAgentSessionMessages = getAgentThreadMessages;

type FlatAssistantSdkMessage = Extract<SDKMessage, { type: "assistant" }>;
type FlatUserSdkMessage = Extract<SDKMessage, { type: "user" }>;

function toSdkUserTextMessage(message: AgentMessage): FlatUserSdkMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    uuid: message.id,
    session_id: message.id,
    timestamp: new Date(message.createdAt).toISOString(),
    message: {
      role: "user",
      content: [{
        type: "text",
        text: message.content
      }]
    }
  };
}

function toSdkAssistantTextMessage(message: AgentMessage): FlatAssistantSdkMessage {
  const content: Array<{ type: "thinking"; thinking: string } | { type: "text"; text: string }> = [];
  if (message.reasoning?.trim()) {
    content.push({ type: "thinking", thinking: message.reasoning });
  }
  if (message.content.trim()) {
    content.push({ type: "text", text: message.content });
  }
  return {
    type: "assistant",
    uuid: message.id,
    session_id: message.id,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content
    }
  };
}

export function getAgentThreadSDKMessages(id: string): SDKMessage[] {
  const sdkMessagesPath = getAgentThreadMessagesPath(id);
  if (existsSync(sdkMessagesPath)) {
    try {
      const raw = readFileSync(sdkMessagesPath, "utf-8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SDKMessage);
    } catch (error) {
      console.error(`[Agent 线程] 读取 SDKMessage 失败 (${id}):`, error);
    }
  }
  const visibleMessages = getAgentThreadMessages(id);
  const flattened: SDKMessage[] = [];
  for (const message of visibleMessages) {
    if (Array.isArray(message.sdkMessages) && message.sdkMessages.length > 0) {
      flattened.push(...message.sdkMessages);
      continue;
    }
    if (message.role === "user") {
      flattened.push(toSdkUserTextMessage(message));
      continue;
    }
    if (message.role === "assistant") {
      flattened.push(toSdkAssistantTextMessage(message));
    }
  }
  return flattened;
}

export function appendAgentThreadSDKMessages(id: string, messages: SDKMessage[]): void {
  if (messages.length === 0) return;
  const sdkMessagesPath = getAgentThreadMessagesPath(id);
  try {
    const payload = messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
    appendFileSync(sdkMessagesPath, payload, "utf-8");
  } catch (error) {
    console.error(`[Agent 线程] 追加 SDKMessage 失败 (${id}):`, error);
    throw new Error("追加 Agent SDKMessage 失败");
  }
}

function rebuildThreadSDKTranscript(threadId: string, messages: AgentMessage[]): void {
  const sdkMessagesPath = getAgentThreadMessagesPath(threadId);
  const sdkMessages = messages.flatMap((message) => {
    if (Array.isArray(message.sdkMessages) && message.sdkMessages.length > 0) {
      return message.sdkMessages;
    }
    if (message.role === "user") {
      return [toSdkUserTextMessage(message)];
    }
    if (message.role === "assistant") {
      return [toSdkAssistantTextMessage(message)];
    }
    return [];
  });
  writeTextAtomic(
    sdkMessagesPath,
    sdkMessages.map((message) => JSON.stringify(message)).join("\n")
  );
}

export function getRecentAgentThreadMessages(id: string, limit: number): AgentRecentMessagesResult {
  const existingStore = readAgentMessageVersionStore(id);
  if (existingStore && existingStore.visibleGroupIds.length > 0) {
    return sliceRecentAgentMessages(getVisibleAgentMessages(id), limit);
  }
  return sliceRecentAgentMessages(readRuntimeCoreTranscriptMessages(id), limit);
}
export const getRecentAgentMessages = getRecentAgentThreadMessages;

export function appendAgentTranscriptMessage(
  id: string,
  message: AgentMessage
): void {
  try {
    if (!message.content.trim()) {
      return;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error(`暂不支持写入该消息角色: ${message.role}`);
    }
    const existingMessages = getAgentThreadMessages(id);
    replaceAgentThreadTranscript(id, [...existingMessages, message]);
  } catch (error) {
    console.error(`[Agent 线程] 追加 transcript 消息失败 (${id}):`, error);
    throw new Error("追加 Agent transcript 消息失败");
  }
}

export function updateAgentThreadMeta(
  id: string,
  updates: Partial<
    Pick<
      AgentThreadMeta,
      "title" | "channelId" | "modelId" | "sdkThreadId" | "runtimeThreadId" | "workspaceId" | "pinned" | "parentThreadId"
    >
  >
): AgentThreadMeta {
  const index = readIndex();
  const idx = index.threads.findIndex((thread) => thread.id === id);
  if (idx === -1) {
    throw new Error(`Agent 线程不存在: ${id}`);
  }

  const existing = index.threads[idx] as AgentThreadMeta;
  const updated: AgentThreadMeta = {
    ...existing,
    ...updates,
    updatedAt: Date.now()
  };

  index.threads[idx] = updated;
  writeIndex(index);

  console.log(`[Agent 线程] 已更新线程: ${updated.title} (${updated.id})`);
  return updated;
}

export function toggleAgentThreadPin(id: string): AgentThreadMeta {
  const meta = getAgentThreadMeta(id);
  if (!meta) {
    throw new Error(`Agent 线程不存在: ${id}`);
  }
  return updateAgentThreadMeta(id, { pinned: !meta.pinned });
}
export const toggleAgentSessionPin = toggleAgentThreadPin;

function moveThreadDir(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) return;
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  try {
    renameSync(sourceDir, targetDir);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== "EXDEV") {
      throw error;
    }
    cpSync(sourceDir, targetDir, { recursive: true });
    rmSync(sourceDir, { recursive: true, force: true });
  }
}

function resolveExistingThreadDir(threadId: string, preferredWorkspaceSlug?: string): string | null {
  if (preferredWorkspaceSlug) {
    const preferredPath = join(getAgentWorkspacePath(preferredWorkspaceSlug), threadId);
    if (existsSync(preferredPath)) {
      return preferredPath;
    }
  }
  const workspacesDir = getAgentWorkspacesDir();
  if (!existsSync(workspacesDir)) {
    return null;
  }
  const entries = readdirSync(workspacesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(workspacesDir, entry.name, threadId);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function moveAgentThreadToWorkspace(id: string, workspaceId: string): AgentThreadMeta {
  const targetWorkspace = getAgentWorkspace(workspaceId);
  if (!targetWorkspace) {
    throw new Error(`目标工作区不存在: ${workspaceId}`);
  }
  ensureWorkspaceAgentAssets(targetWorkspace.slug, targetWorkspace.name);
  const currentMeta = getAgentThreadMeta(id);
  if (!currentMeta) {
    throw new Error(`Agent 线程不存在: ${id}`);
  }

  const currentWorkspace = currentMeta.workspaceId
    ? getAgentWorkspace(currentMeta.workspaceId)
    : undefined;
  const sourceDir = resolveExistingThreadDir(id, currentWorkspace?.slug);
  const targetDir = join(getAgentWorkspacePath(targetWorkspace.slug), id);

  if (sourceDir && sourceDir !== targetDir) {
    moveThreadDir(sourceDir, targetDir);
  } else if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  return updateAgentThreadMeta(id, {
    workspaceId: workspaceId,
    sdkThreadId: undefined,
    runtimeThreadId: undefined
  });
}
export const moveAgentSessionToWorkspace = moveAgentThreadToWorkspace;

/**
 * 迁移 Chat 对话消息到指定 Agent 线程。
 * 仅迁移 user/assistant 且有文本内容的消息，忽略工具活动与附件。
 */
export function migrateChatToAgentThread(conversationId: string, agentThreadId: string): number {
  const thread = getAgentThreadMeta(agentThreadId);
  if (!thread) {
    throw new Error(`Agent 线程不存在: ${agentThreadId}`);
  }

  const chatMessages = getConversationMessages(conversationId);
  if (chatMessages.length === 0) {
    return 0;
  }

  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(agentThreadId);
  if (existsSync(runtimeCoreSessionDir)) {
    rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
  }

  const sessionManager = createOrResumeRuntimeCoreSessionManager(resolveAgentThreadCwd(agentThreadId), agentThreadId);
  let migratedCount = 0;
  for (const message of chatMessages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!message.content.trim()) continue;
    if (message.role === "user") {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: message.content }],
        timestamp: message.createdAt
      });
      migratedCount += 1;
      continue;
    }

    const resolvedModel = typeof message.model === "string" ? message.model.trim() : "";
    const [provider, ...restModel] = resolvedModel.split("/");
    const assistantModel = restModel.length > 0
      ? restModel.join("/")
      : (resolvedModel || "unknown");
    const assistantProvider = provider && restModel.length > 0 ? provider : "unknown";
    sessionManager.appendMessage({
      role: "assistant",
      provider: assistantProvider,
      model: assistantModel,
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
      content: [{ type: "text", text: message.content }],
      timestamp: message.createdAt
    });
    migratedCount += 1;
  }

  if (migratedCount > 0) {
    updateAgentThreadMeta(agentThreadId, {});
  }
  return migratedCount;
}
export const migrateChatToAgentSession = migrateChatToAgentThread;

export function deleteAgentThread(id: string): void {
  const index = readIndex();
  const idx = index.threads.findIndex((thread) => thread.id === id);
  if (idx === -1) {
    throw new Error(`Agent 线程不存在: ${id}`);
  }

  const removed = index.threads.splice(idx, 1)[0] as AgentThreadMeta;
  writeIndex(index);

  try {
    const workspacesDir = getAgentWorkspacesDir();
    const workspaceEntries = readdirSync(workspacesDir, { withFileTypes: true });
    for (const entry of workspaceEntries) {
      if (!entry.isDirectory()) continue;
      const threadDir = join(workspacesDir, entry.name, id);
      if (!existsSync(threadDir)) continue;
      rmSync(threadDir, { recursive: true, force: true });
      console.log(`[Agent 线程] 已清理线程工作目录: ${threadDir}`);
    }
  } catch (error) {
    console.warn(`[Agent 线程] 清理线程工作目录失败 (${id}):`, error);
  }

  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(id);
  if (existsSync(runtimeCoreSessionDir)) {
    try {
      rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
      console.log(`[Agent 线程] 已清理 runtime-core transcript: ${runtimeCoreSessionDir}`);
    } catch (error) {
      console.warn(`[Agent 线程] 清理 runtime-core transcript 失败 (${id}):`, error);
    }
  }

  const sessionDataDir = getAgentSessionDataDir(id);
  if (existsSync(sessionDataDir)) {
    try {
      rmSync(sessionDataDir, { recursive: true, force: true });
      console.log(`[Agent 线程] 已清理线程版本数据: ${sessionDataDir}`);
    } catch (error) {
      console.warn(`[Agent 线程] 清理线程版本数据失败 (${id}):`, error);
    }
  }

  console.log(`[Agent 线程] 已删除线程: ${removed.title} (${removed.id})`);
}
export const deleteAgentSession = deleteAgentThread;

export function truncateAgentMessagesFrom(threadId: string, messageId: string): AgentMessage[] {
  const messages = getAgentThreadMessages(threadId);
  const targetIndex = messages.findIndex((msg) => msg.id === messageId);
  if (targetIndex === -1) {
    return messages;
  }

  const kept = messages.slice(0, targetIndex);
  replaceAgentThreadTranscript(threadId, kept);
  return kept;
}

export const truncateAgentThreadMessagesFrom = truncateAgentMessagesFrom;

/**
 * 从指定消息处分叉线程：创建新线程，复制截断后的消息
 */
export function forkAgentThread(
  sourceThreadId: string,
  upToMessageId: string
): { newThreadId: string } {
  const messages = getAgentThreadMessages(sourceThreadId);
  const targetIndex = messages.findIndex((msg) => msg.id === upToMessageId);
  if (targetIndex === -1) {
    throw new Error(`消息 ${upToMessageId} 在线程 ${sourceThreadId} 中未找到`);
  }

  // 截取到目标消息（含）
  const forkedMessages = messages.slice(0, targetIndex + 1);

  const sourceMeta = getAgentThreadMeta(sourceThreadId);
  const newThread = createAgentThread(
    sourceMeta?.title ? `${sourceMeta.title} (分叉)` : "分叉线程",
    sourceMeta?.channelId,
    sourceMeta?.workspaceId,
    sourceThreadId,
    sourceMeta?.modelId
  );

  replaceAgentThreadTranscript(newThread.id, forkedMessages);

  console.log(`[Agent 线程] 已从 ${sourceThreadId.slice(0, 8)} 分叉到 ${newThread.id.slice(0, 8)}，包含 ${forkedMessages.length} 条消息`);
  return { newThreadId: newThread.id };
}
export const forkAgentSession = forkAgentThread;

export function replaceAgentThreadTranscript(threadId: string, messages: AgentMessage[]): void {
  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(threadId);
  if (existsSync(runtimeCoreSessionDir)) {
    rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
  }
  resetAgentMessageVersionStore(threadId);
  rebuildRuntimeCoreTranscript(threadId, messages);
  rebuildThreadSDKTranscript(threadId, messages);
  updateAgentThreadMeta(threadId, {
    sdkThreadId: undefined,
    runtimeThreadId: undefined
  });
}
export const replaceAgentSessionTranscript = replaceAgentThreadTranscript;

function rebuildRuntimeCoreTranscript(threadId: string, messages: AgentMessage[]): void {
  if (messages.length === 0) {
    return;
  }
  const sessionManager = createOrResumeRuntimeCoreSessionManager(resolveAgentThreadCwd(threadId), threadId);
  for (const message of messages) {
    if (!message.content.trim()) {
      continue;
    }
    if (message.role === "user") {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: message.content }],
        timestamp: message.createdAt
      });
      continue;
    }
      if (message.role === "assistant") {
      const { provider, model } = resolveTranscriptAppendModel(message.model);
      const contentBlocks: Array<
        { type: "thinking"; thinking: string } |
        { type: "text"; text: string }
      > = [];
      if (message.reasoning?.trim()) {
        contentBlocks.push({ type: "thinking", thinking: message.reasoning });
      }
      if (message.content.trim()) {
        contentBlocks.push({ type: "text", text: message.content });
      }
      sessionManager.appendMessage({
        role: "assistant",
        provider,
        model,
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
        content: contentBlocks,
        timestamp: message.createdAt
      });
    }
  }
}

function resolveTranscriptAppendModel(model: string | undefined): {
  provider: string;
  model: string;
} {
  const resolvedModel = typeof model === "string" ? model.trim() : "";
  const [provider, ...restModel] = resolvedModel.split("/");
  if (provider && restModel.length > 0) {
    return {
      provider,
      model: restModel.join("/")
    };
  }
  return {
    provider: "unknown",
    model: resolvedModel || "unknown"
  };
}

export function readRuntimeCoreTranscriptMessages(sessionId: string): AgentMessage[] {
  if (!hasRuntimeCoreSessionTranscript(sessionId)) {
    return [];
  }
  const sessionManager = createOrResumeRuntimeCoreSessionManager(resolveAgentThreadCwd(sessionId), sessionId);
  const messages = sessionManager.buildSessionContext().messages as RuntimeCoreContextMessage[];

  const projectedMessages: AgentMessage[] = [];
  const toolCallOwnerMap = new Map<string, number>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;

    if (message.role === "user" || message.role === "assistant") {
      const content = extractRenderableAssistantText(message.content).trim();
      const reasoning = extractAssistantReasoningText(message.content).trim();
      const turnId = `runtime-core:${sessionId}:${index}`;

      if (!content && !reasoning) {
        if (message.role === "assistant") {
          const sdkAssistantMessage = toSdkAssistantMessage(message, turnId);
          if ((sdkAssistantMessage.message.content ?? []).length > 0) {
            const projected: AgentMessage = {
              id: turnId,
              role: "assistant",
              content: "",
              createdAt: resolveRuntimeCoreMessageTimestamp(message, index),
              model: resolveRuntimeCoreMessageModel(message),
              sdkMessages: [sdkAssistantMessage]
            };
            projectedMessages.push(projected);
            const pIdx = projectedMessages.length - 1;
            for (const tc of extractToolCallsFromContent(message.content)) {
              toolCallOwnerMap.set(tc.id, pIdx);
            }
          }
        }
        continue;
      }

      const decorations = message.role === "assistant" ? deriveRuntimeCoreAssistantDecorations(content, message) : {};

      const projected: AgentMessage = {
        id: turnId,
        role: message.role,
        content,
        ...(reasoning ? { reasoning } : {}),
        createdAt: resolveRuntimeCoreMessageTimestamp(message, index),
        model: message.role === "assistant" ? resolveRuntimeCoreMessageModel(message) : undefined,
        sdkMessages: [message.role === "assistant" ? toSdkAssistantMessage(message, turnId) : toSdkUserMessage(message, turnId)],
        ...decorations
      };
      projectedMessages.push(projected);

      if (message.role === "assistant") {
        const pIdx = projectedMessages.length - 1;
        for (const tc of extractToolCallsFromContent(message.content)) {
          toolCallOwnerMap.set(tc.id, pIdx);
        }
      }
    } else if (message.role === "toolResult") {
      // 将工具结果关联到拥有对应 toolCall 的 assistant 消息
      const toolResult = message as RuntimeCoreContextMessage & {
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
      };
      const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
      if (!toolCallId) continue;

      const ownerIdx = toolCallOwnerMap.get(toolCallId);
      if (ownerIdx === undefined) continue;

      const owner = projectedMessages[ownerIdx]!;
      owner.sdkMessages = [...(owner.sdkMessages ?? []), toSdkToolResultMessage(toolResult)];
    }
  }

  return mergeAdjacentAssistantMessages(projectedMessages);
}

/**
 * 合并相邻的 assistant 消息为一条。
 *
 * SDK transcript 在一次用户请求中可能产生多个 assistant 回合
 * （因为中间穿插了工具调用、AskUserQuestion 等交互），后端将每个回合
 * 投影为独立的 AgentMessage。前端应将中间没有 user 消息间隔的相邻
 * assistant 消息合并为一条，避免 UI 显示为多个独立消息气泡。
 *
 * 合并规则：
 * - reasoning：取第一条有 reasoning 的值（通常只有第一个回合有）
 * - content：拼接所有回合的 content（用换行分隔）
 * - createdAt：保留最早的时间戳
 * - model / metadata：保留最后一条的值
 */
function mergeAdjacentAssistantMessages(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (const msg of messages) {
    const prev = result.length > 0 ? result[result.length - 1]! : null;
    if (
      prev
      && prev.role === "assistant"
      && msg.role === "assistant"
    ) {
      // 合并相邻 assistant 消息
      const mergedContent = [prev.content, msg.content].filter(Boolean).join("\n\n");
      result[result.length - 1] = {
        ...msg,
        content: mergedContent,
        reasoning: prev.reasoning || msg.reasoning,
        createdAt: prev.createdAt,
        sdkMessages: mergeOptionalSdkMessages(prev.sdkMessages, msg.sdkMessages),
      };
    } else {
      result.push(msg);
    }
  }
  return result;
}

function mergeOptionalSdkMessages(
  a: AgentMessage["sdkMessages"],
  b: AgentMessage["sdkMessages"],
): AgentMessage["sdkMessages"] {
  if (!a && !b) return undefined;
  return [...(a ?? []), ...(b ?? [])];
}

interface ExtractedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type TranscriptAssistantSdkMessage = Extract<SDKMessage, { type: "assistant" }>;
type TranscriptUserSdkMessage = Extract<SDKMessage, { type: "user" }>;

function toSdkAssistantMessage(message: RuntimeCoreContextMessage, turnId: string): TranscriptAssistantSdkMessage {
  return {
    type: "assistant",
    uuid: turnId,
    session_id: turnId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: normalizeSdkAssistantContent(message.content)
    }
  };
}

function toSdkUserMessage(message: RuntimeCoreContextMessage, turnId: string): TranscriptUserSdkMessage {
  return {
    type: "user",
    uuid: turnId,
    session_id: turnId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{
        type: "text",
        text: extractRenderableAssistantText(message.content)
      }]
    }
  };
}

function toSdkToolResultMessage(toolResult: RuntimeCoreContextMessage & {
  toolCallId?: string;
  isError?: boolean;
}): TranscriptUserSdkMessage {
  return {
    type: "user",
    parent_tool_use_id: toolResult.toolCallId ?? null,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolResult.toolCallId ?? "unknown",
        content: extractRenderableAssistantText(toolResult.content),
        ...(toolResult.isError ? { is_error: true } : {})
      }]
    }
  };
}

type LocalSdkContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function normalizeSdkAssistantContent(content: unknown): LocalSdkContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: LocalSdkContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if ((type === "thinking" || type === "reasoning") && typeof block.thinking === "string") {
      blocks.push({ type: "thinking", thinking: block.thinking });
      continue;
    }
    if ((type === "toolCall" || type === "tool_use") && typeof block.id === "string" && typeof block.name === "string") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
          ? (block.arguments as Record<string, unknown>)
          : {}
      });
    }
  }
  return blocks;
}

/**
 * 从 assistant message 的 content 数组中提取 toolCall 块。
 *
 * SDK transcript 中 assistant message content 是一个 content block 数组，
 * 其中 type="toolCall" 的块包含工具调用信息。
 */
function extractToolCallsFromContent(content: unknown): ExtractedToolCall[] {
  if (!Array.isArray(content)) return [];
  const toolCalls: ExtractedToolCall[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string; id?: string; name?: string; arguments?: unknown };
    if (block.type !== "toolCall" && block.type !== "tool_use") continue;
    const id = typeof block.id === "string" ? block.id : "";
    const name = typeof block.name === "string" ? block.name : "";
    if (!id || !name) continue;
    const args = block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
      ? (block.arguments as Record<string, unknown>)
      : {};
    toolCalls.push({ id, name, arguments: args });
  }
  return toolCalls;
}

function deriveRuntimeCoreAssistantDecorations(
  content: string,
  message: RuntimeCoreContextMessage
): Pick<AgentMessage, "metadata"> {
  if (resolveRuntimeCoreMessageModel(message) !== "subagent/announce") {
    return {};
  }
  const metadata = parseSubagentAnnounceMetadata(content);
  const runId = typeof metadata.runId === "string" ? metadata.runId : "unknown";
  const childSessionId = typeof metadata.childSessionId === "string" ? metadata.childSessionId : "unknown";
  const status = typeof metadata.status === "string" ? metadata.status : "completed";
  const toolUseId = `subagent-announce:${runId}`;
  return {
    metadata: {
      ...metadata,
      toolUseId
    }
  };
}

function resolveRuntimeCoreMessageTimestamp(message: RuntimeCoreContextMessage, index: number): number {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  return index;
}

function resolveRuntimeCoreMessageModel(message: RuntimeCoreContextMessage): string | undefined {
  const provider = typeof message.provider === "string" ? message.provider.trim() : "";
  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return model || undefined;
}

function parseSubagentAnnounceMetadata(content: string): Record<string, unknown> {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  const headline = lines[0] ?? "";
  const runIdLine = lines.find((line) => line.startsWith("runId:"));
  const childSessionLine = lines.find((line) => line.startsWith("childSessionKey:"));
  const statusMatch = headline.match(/\((completed|errored|aborted|timed_out|canceled|running|accepted)\)\s*$/);
  const runId = runIdLine?.slice("runId:".length).trim();
  const childSessionId = childSessionLine?.slice("childSessionKey:".length).trim();
  const status = statusMatch?.[1];
  return {
    subagentAnnounce: true,
    ...(runId ? { runId } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(status ? { status } : {})
  };
}

function resolveAgentThreadCwd(threadId: string): string {
  const meta = getAgentThreadMeta(threadId);
  if (!meta?.workspaceId) {
    return process.cwd();
  }
  const workspace = getAgentWorkspace(meta.workspaceId);
  if (!workspace) {
    return process.cwd();
  }
  return getAgentSessionWorkspacePath(workspace.slug, threadId);
}

function sliceRecentAgentMessages(messages: AgentMessage[], limit: number): AgentRecentMessagesResult {
  if (messages.length <= limit) {
    return {
      messages,
      total: messages.length,
      hasMore: false
    };
  }
  return {
    messages: messages.slice(-limit),
    total: messages.length,
    hasMore: true
  };
}
