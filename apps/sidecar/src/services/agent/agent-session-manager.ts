/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-session-manager.ts
 * Adaptation:
 * - Shared imports updated to `@lume/shared`.
 * - Config root and paths are resolved by sidecar `config-paths` (`~/.lume`).
 */

import {
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
import type { AgentEvent, AgentMessage, AgentRecentMessagesResult, AgentSessionMeta } from "@lume/shared";
import {
  getAgentSessionDataDir,
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
import { getConversationMessages } from "../chat/conversation-manager";
import { extractAssistantReasoningText, extractRenderableAssistantText } from "../pi-agent/content-extraction";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDirPath,
  hasRuntimeCoreSessionTranscript
} from "../pi-agent/runtime-core/session-store";

interface AgentSessionsIndex {
  version: number;
  sessions: AgentSessionMeta[];
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

function readIndex(): AgentSessionsIndex {
  const indexPath = getAgentSessionsIndexPath();
  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, sessions: [] };
  }

  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")) as AgentSessionsIndex;
  } catch (error) {
    console.error("[Agent 会话] 读取索引文件失败:", error);
    backupCorruptFile(indexPath, "Agent 会话");
    return { version: INDEX_VERSION, sessions: [] };
  }
}

function writeIndex(index: AgentSessionsIndex): void {
  const indexPath = getAgentSessionsIndexPath();
  try {
    writeTextAtomic(indexPath, JSON.stringify(index, null, 2));
  } catch (error) {
    console.error("[Agent 会话] 写入索引文件失败:", error);
    throw new Error("写入 Agent 会话索引失败");
  }
}

export function listAgentSessions(): AgentSessionMeta[] {
  return readIndex().sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getAgentSessionMeta(id: string): AgentSessionMeta | undefined {
  return readIndex().sessions.find((session) => session.id === id);
}

export function createAgentSession(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  parentSessionId?: string,
  modelId?: string
): AgentSessionMeta {
  const index = readIndex();
  const now = Date.now();

  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: title || "新 Agent 会话",
    channelId,
    modelId,
    workspaceId,
    parentSessionId,
    pinned: false,
    createdAt: now,
    updatedAt: now
  };

  index.sessions.push(meta);
  writeIndex(index);

  if (workspaceId) {
    const workspace = getAgentWorkspace(workspaceId);
    if (workspace) {
      ensureWorkspaceAgentAssets(workspace.slug, workspace.name);
      getAgentSessionWorkspacePath(workspace.slug, meta.id);
    }
  }

  console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`);
  return meta;
}

export function getAgentSessionMessages(id: string): AgentMessage[] {
  const transcriptMessages = readRuntimeCoreTranscriptMessages(id);
  syncVersionStoreFromMessages(id, transcriptMessages);
  return getVisibleAgentMessages(id);
}

export function getRecentAgentMessages(id: string, limit: number): AgentRecentMessagesResult {
  return sliceRecentAgentMessages(readRuntimeCoreTranscriptMessages(id), limit);
}

export function appendAgentTranscriptMessage(
  id: string,
  message: AgentMessage
): void {
  try {
    const sessionManager = createOrResumeRuntimeCoreSessionManager(resolveAgentSessionCwd(id), id);
    if (!message.content.trim()) {
      return;
    }
    if (message.role === "user") {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: message.content }],
        timestamp: message.createdAt
      });
      return;
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
        api: "manual-append",
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
      return;
    }
    throw new Error(`暂不支持写入该消息角色: ${message.role}`);
  } catch (error) {
    console.error(`[Agent 会话] 追加 transcript 消息失败 (${id}):`, error);
    throw new Error("追加 Agent transcript 消息失败");
  }
}

export function updateAgentSessionMeta(
  id: string,
  updates: Partial<
    Pick<
      AgentSessionMeta,
      "title" | "channelId" | "modelId" | "sdkSessionId" | "piSessionId" | "workspaceId" | "pinned"
    >
  >
): AgentSessionMeta {
  const index = readIndex();
  const idx = index.sessions.findIndex((session) => session.id === id);
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`);
  }

  const existing = index.sessions[idx] as AgentSessionMeta;
  const updated: AgentSessionMeta = {
    ...existing,
    ...updates,
    updatedAt: Date.now()
  };

  index.sessions[idx] = updated;
  writeIndex(index);

  console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`);
  return updated;
}

export function toggleAgentSessionPin(id: string): AgentSessionMeta {
  const meta = getAgentSessionMeta(id);
  if (!meta) {
    throw new Error(`Agent 会话不存在: ${id}`);
  }
  return updateAgentSessionMeta(id, { pinned: !meta.pinned });
}

function moveSessionDir(sourceDir: string, targetDir: string): void {
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

function resolveExistingSessionDir(sessionId: string, preferredWorkspaceSlug?: string): string | null {
  if (preferredWorkspaceSlug) {
    const preferredPath = join(getAgentWorkspacePath(preferredWorkspaceSlug), sessionId);
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
    const candidate = join(workspacesDir, entry.name, sessionId);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function moveAgentSessionToWorkspace(id: string, workspaceId: string): AgentSessionMeta {
  const targetWorkspace = getAgentWorkspace(workspaceId);
  if (!targetWorkspace) {
    throw new Error(`目标工作区不存在: ${workspaceId}`);
  }
  ensureWorkspaceAgentAssets(targetWorkspace.slug, targetWorkspace.name);
  const currentMeta = getAgentSessionMeta(id);
  if (!currentMeta) {
    throw new Error(`Agent 会话不存在: ${id}`);
  }

  const currentWorkspace = currentMeta.workspaceId
    ? getAgentWorkspace(currentMeta.workspaceId)
    : undefined;
  const sourceDir = resolveExistingSessionDir(id, currentWorkspace?.slug);
  const targetDir = join(getAgentWorkspacePath(targetWorkspace.slug), id);

  if (sourceDir && sourceDir !== targetDir) {
    moveSessionDir(sourceDir, targetDir);
  } else if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  return updateAgentSessionMeta(id, {
    workspaceId: workspaceId,
    sdkSessionId: undefined,
    piSessionId: undefined
  });
}

/**
 * 迁移 Chat 对话消息到指定 Agent 会话。
 * 仅迁移 user/assistant 且有文本内容的消息，忽略工具活动与附件。
 */
export function migrateChatToAgentSession(conversationId: string, agentSessionId: string): number {
  const session = getAgentSessionMeta(agentSessionId);
  if (!session) {
    throw new Error(`Agent 会话不存在: ${agentSessionId}`);
  }

  const chatMessages = getConversationMessages(conversationId);
  if (chatMessages.length === 0) {
    return 0;
  }

  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(agentSessionId);
  if (existsSync(runtimeCoreSessionDir)) {
    rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
  }

  const sessionManager = createOrResumeRuntimeCoreSessionManager(resolveAgentSessionCwd(agentSessionId), agentSessionId);
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
    updateAgentSessionMeta(agentSessionId, {});
  }
  return migratedCount;
}

export function deleteAgentSession(id: string): void {
  const index = readIndex();
  const idx = index.sessions.findIndex((session) => session.id === id);
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`);
  }

  const removed = index.sessions.splice(idx, 1)[0] as AgentSessionMeta;
  writeIndex(index);

  try {
    const workspacesDir = getAgentWorkspacesDir();
    const workspaceEntries = readdirSync(workspacesDir, { withFileTypes: true });
    for (const entry of workspaceEntries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = join(workspacesDir, entry.name, id);
      if (!existsSync(sessionDir)) continue;
      rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[Agent 会话] 已清理 session 工作目录: ${sessionDir}`);
    }
  } catch (error) {
    console.warn(`[Agent 会话] 清理 session 工作目录失败 (${id}):`, error);
  }

  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(id);
  if (existsSync(runtimeCoreSessionDir)) {
    try {
      rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
      console.log(`[Agent 会话] 已清理 runtime-core transcript: ${runtimeCoreSessionDir}`);
    } catch (error) {
      console.warn(`[Agent 会话] 清理 runtime-core transcript 失败 (${id}):`, error);
    }
  }

  const sessionDataDir = getAgentSessionDataDir(id);
  if (existsSync(sessionDataDir)) {
    try {
      rmSync(sessionDataDir, { recursive: true, force: true });
      console.log(`[Agent 会话] 已清理会话版本数据: ${sessionDataDir}`);
    } catch (error) {
      console.warn(`[Agent 会话] 清理会话版本数据失败 (${id}):`, error);
    }
  }

  console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`);
}

export function truncateAgentMessagesFrom(sessionId: string, messageId: string): AgentMessage[] {
  const messages = getAgentSessionMessages(sessionId);
  const targetIndex = messages.findIndex((msg) => msg.id === messageId);
  if (targetIndex === -1) {
    return messages;
  }

  const kept = messages.slice(0, targetIndex);
  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(sessionId);
  if (existsSync(runtimeCoreSessionDir)) {
    rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
  }
  rebuildRuntimeCoreTranscript(sessionId, kept);

  // 截断会话后重置 transcript / SDK 会话衔接，避免 resume 命中旧上下文。
  updateAgentSessionMeta(sessionId, {
    sdkSessionId: undefined,
    piSessionId: undefined
  });
  return kept;
}

/**
 * 从指定消息处分叉会话：创建新 session，复制截断后的消息
 */
export function forkAgentSession(
  sourceSessionId: string,
  upToMessageId: string
): { newSessionId: string } {
  const messages = getAgentSessionMessages(sourceSessionId);
  const targetIndex = messages.findIndex((msg) => msg.id === upToMessageId);
  if (targetIndex === -1) {
    throw new Error(`消息 ${upToMessageId} 在会话 ${sourceSessionId} 中未找到`);
  }

  // 截取到目标消息（含）
  const forkedMessages = messages.slice(0, targetIndex + 1);

  // 获取源 session meta 以复制工作区等信息
  const sourceMeta = getAgentSessionMeta(sourceSessionId);
  const newSession = createAgentSession(
    sourceMeta?.title ? `${sourceMeta.title} (分叉)` : "分叉会话",
    sourceMeta?.channelId,
    sourceMeta?.workspaceId,
    sourceSessionId,
    sourceMeta?.modelId
  );

  // 为新 session 重建 transcript
  rebuildRuntimeCoreTranscript(newSession.id, forkedMessages);

  console.log(`[Agent 会话] 已从 ${sourceSessionId.slice(0, 8)} 分叉到 ${newSession.id.slice(0, 8)}，包含 ${forkedMessages.length} 条消息`);
  return { newSessionId: newSession.id };
}

export function replaceAgentSessionTranscript(sessionId: string, messages: AgentMessage[]): void {
  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(sessionId);
  if (existsSync(runtimeCoreSessionDir)) {
    rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
  }
  rebuildRuntimeCoreTranscript(sessionId, messages);
  updateAgentSessionMeta(sessionId, {
    sdkSessionId: undefined,
    piSessionId: undefined
  });
}

function rebuildRuntimeCoreTranscript(sessionId: string, messages: AgentMessage[]): void {
  if (messages.length === 0) {
    return;
  }
  const sessionManager = createOrResumeRuntimeCoreSessionManager(resolveAgentSessionCwd(sessionId), sessionId);
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
  const sessionManager = createOrResumeRuntimeCoreSessionManager(resolveAgentSessionCwd(sessionId), sessionId);
  const messages = sessionManager.buildSessionContext().messages as RuntimeCoreContextMessage[];

  // 两遍扫描：
  // 第一遍：投影 user/assistant 消息，同时从 assistant content 中提取 toolCall events
  // 第二遍：将 toolResult 消息关联到最近的 assistant 消息的 events 中
  const projectedMessages: AgentMessage[] = [];
  // 跟踪 toolCallId → 最近拥有该 toolCall 的 assistant 消息在 projectedMessages 中的索引
  const toolCallOwnerMap = new Map<string, number>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;

    if (message.role === "user" || message.role === "assistant") {
      const content = extractRenderableAssistantText(message.content).trim();
      const reasoning = extractAssistantReasoningText(message.content).trim();
      const turnId = `runtime-core:${sessionId}:${index}`;

      if (!content && !reasoning) {
        // assistant 消息可能只有 toolCall 没有文本，也需要提取工具事件
        if (message.role === "assistant") {
          const contentEvents = extractContentEventsInOrder(message.content, turnId);
          if (contentEvents.length > 0) {
            const projected: AgentMessage = {
              id: turnId,
              role: "assistant",
              content: "",
              createdAt: resolveRuntimeCoreMessageTimestamp(message, index),
              model: resolveRuntimeCoreMessageModel(message),
              events: contentEvents
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
      const existingEvents = decorations.events ?? [];
      // 从 content 按原始顺序提取文本和工具调用事件
      const contentEvents = message.role === "assistant"
        ? extractContentEventsInOrder(message.content, turnId)
        : [];
      const allEvents = [...existingEvents, ...contentEvents];

      const projected: AgentMessage = {
        id: turnId,
        role: message.role,
        content,
        ...(reasoning ? { reasoning } : {}),
        createdAt: resolveRuntimeCoreMessageTimestamp(message, index),
        model: message.role === "assistant" ? resolveRuntimeCoreMessageModel(message) : undefined,
        ...decorations,
        ...(allEvents.length > 0 ? { events: allEvents } : {})
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

      const resultText = extractRenderableAssistantText(toolResult.content).trim();
      const toolResultEvent: AgentEvent = {
        type: "tool_result",
        toolUseId: toolCallId,
        toolName: typeof toolResult.toolName === "string" ? toolResult.toolName : undefined,
        result: resultText.length > 20_000
          ? resultText.slice(0, 20_000) + "\n...(输出过长已截断)"
          : resultText,
        isError: !!toolResult.isError
      };

      const owner = projectedMessages[ownerIdx]!;
      owner.events = [...(owner.events ?? []), toolResultEvent];
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
 * - events：合并所有回合的 events
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
        events: mergeOptionalEvents(prev.events, msg.events),
      };
    } else {
      result.push(msg);
    }
  }
  return result;
}

function mergeOptionalEvents(
  a: AgentMessage["events"],
  b: AgentMessage["events"],
): AgentMessage["events"] {
  if (!a && !b) return undefined;
  return [...(a ?? []), ...(b ?? [])];
}

interface ExtractedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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

/**
 * 从 assistant message 的 content 数组中按原始顺序提取事件。
 *
 * 按照 content block 的出现顺序生成 text_complete 和 tool_start 事件，
 * 使前端 EventTimeline 能按正确的时间顺序交替展示文本和工具调用。
 * thinking/reasoning 块不在此提取（已由 extractAssistantReasoningText 处理）。
 */
function extractContentEventsInOrder(content: unknown, turnId: string): AgentEvent[] {
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  let textAccum = "";

  function flushText(): void {
    const text = textAccum.trim();
    if (text) {
      events.push({
        type: "text_complete" as const,
        text,
        isIntermediate: false,
        turnId
      });
    }
    textAccum = "";
  }

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string; id?: string; name?: string; arguments?: unknown; text?: string; thinking?: string };
    const blockType = typeof block.type === "string" ? block.type : "";

    if (blockType === "thinking" || blockType === "reasoning") {
      // reasoning 由 extractAssistantReasoningText 单独处理，这里跳过
      continue;
    }

    if (blockType === "toolCall" || blockType === "tool_use") {
      flushText();
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      if (id && name) {
        const args = block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
          ? (block.arguments as Record<string, unknown>)
          : {};
        events.push({
          type: "tool_start" as const,
          toolName: name,
          toolUseId: id,
          input: args,
          turnId
        });
      }
      continue;
    }

    // text / output_text / outputText / 无类型 → 文本块
    if (blockType === "text" || blockType === "output_text" || blockType === "outputText" || !blockType) {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) textAccum += text;
    }
  }

  flushText();
  return events;
}

function deriveRuntimeCoreAssistantDecorations(
  content: string,
  message: RuntimeCoreContextMessage
): Pick<AgentMessage, "metadata" | "events"> {
  if (resolveRuntimeCoreMessageModel(message) !== "subagent/announce") {
    return {};
  }
  const metadata = parseSubagentAnnounceMetadata(content);
  const runId = typeof metadata.runId === "string" ? metadata.runId : "unknown";
  const childSessionId = typeof metadata.childSessionId === "string" ? metadata.childSessionId : "unknown";
  const status = typeof metadata.status === "string" ? metadata.status : "completed";
  const toolUseId = `subagent-announce:${runId}`;
  return {
    metadata,
    events: [
      {
        type: "tool_start",
        toolName: "Agent",
        toolUseId,
        input: {
          subagent_type: "completion_announce",
          run_id: runId,
          child_session_key: childSessionId
        }
      },
      {
        type: "tool_result",
        toolUseId,
        toolName: "Agent",
        result: JSON.stringify({
          runId,
          status,
          childSessionKey: childSessionId
        }, null, 2),
        isError: status !== "completed"
      }
    ]
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

function resolveAgentSessionCwd(sessionId: string): string {
  const meta = getAgentSessionMeta(sessionId);
  if (!meta?.workspaceId) {
    return process.cwd();
  }
  const workspace = getAgentWorkspace(meta.workspaceId);
  if (!workspace) {
    return process.cwd();
  }
  return getAgentSessionWorkspacePath(workspace.slug, sessionId);
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
