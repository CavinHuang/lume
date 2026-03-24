/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-session-manager.ts
 * Adaptation:
 * - Shared imports updated to `@lume/shared`.
 * - Config root and paths are resolved by sidecar `config-paths` (`~/.lume`).
 */

import {
  cpSync,
  appendFileSync,
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
import type { AgentMessage, AgentRecentMessagesResult, AgentSessionMeta } from "@lume/shared";
import {
  getAgentWorkspacesDir,
  getAgentWorkspacePath,
  getAgentSessionWorkspacePath,
  getAgentSessionsIndexPath
} from "./config-paths";
import { ensureWorkspaceAgentAssets, getAgentWorkspace } from "./agent-workspace-manager";
import { getConversationMessages } from "./conversation-manager";
import { extractRenderableAssistantText } from "./pi-agent/content-extraction";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreCompatibilityMessagesPath,
  getRuntimeCoreSessionDirPath,
  hasRuntimeCoreSessionTranscript
} from "./pi-agent/runtime-core/session-store";

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

type AgentCompatibilityKind = "subagent_announce" | "message_metadata_overlay";

interface AgentCompatibilityMetadata extends Record<string, unknown> {
  __lumeCompatibilityKind?: AgentCompatibilityKind;
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
  parentSessionId?: string
): AgentSessionMeta {
  const index = readIndex();
  const now = Date.now();

  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: title || "新 Agent 会话",
    channelId,
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
  if (transcriptMessages.length > 0) {
    return mergeTranscriptWithCompatibilityMessages(transcriptMessages, readAgentCompatibilityMessages(id));
  }

  return readAgentCompatibilityMessages(id);
}

export function getRecentAgentMessages(id: string, limit: number): AgentRecentMessagesResult {
  const transcriptMessages = readRuntimeCoreTranscriptMessages(id);
  if (transcriptMessages.length > 0) {
    return sliceRecentAgentMessages(
      mergeTranscriptWithCompatibilityMessages(transcriptMessages, readAgentCompatibilityMessages(id)),
      limit
    );
  }

  return sliceRecentAgentMessages(readAgentCompatibilityMessages(id), limit);
}

export function appendAgentCompatibilityMessage(
  id: string,
  message: AgentMessage,
  kind: AgentCompatibilityKind = "message_metadata_overlay"
): void {
  const filePath = getRuntimeCoreCompatibilityMessagesPath(id);
  try {
    mkdirSync(getRuntimeCoreSessionDirPath(id), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(withCompatibilityKind(message, kind))}\n`, "utf-8");
  } catch (error) {
    console.error(`[Agent 会话] 追加兼容消息失败 (${id}):`, error);
    throw new Error("追加 Agent 兼容消息失败");
  }
}

export function updateAgentSessionMeta(
  id: string,
  updates: Partial<
    Pick<
      AgentSessionMeta,
      "title" | "channelId" | "sdkSessionId" | "piSessionId" | "workspaceId" | "pinned"
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
    }
  }
}

function readRuntimeCoreTranscriptMessages(sessionId: string): AgentMessage[] {
  if (!hasRuntimeCoreSessionTranscript(sessionId)) {
    return [];
  }
  const sessionManager = createOrResumeRuntimeCoreSessionManager(resolveAgentSessionCwd(sessionId), sessionId);
  const messages = sessionManager.buildSessionContext().messages as RuntimeCoreContextMessage[];
  const projectedMessages = messages
    .flatMap((message, index) => {
      if (message.role !== "user" && message.role !== "assistant") {
        return [];
      }
      const content = extractRenderableAssistantText(message.content).trim();
      if (!content) {
        return [];
      }
      return [{
        id: `runtime-core:${sessionId}:${index}`,
        role: message.role,
        content,
        createdAt: resolveRuntimeCoreMessageTimestamp(message, index),
        model: message.role === "assistant" ? resolveRuntimeCoreMessageModel(message) : undefined
      } satisfies AgentMessage];
    });
  return projectedMessages;
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

function readAgentCompatibilityMessages(id: string): AgentMessage[] {
  return readAgentMessageRows(id).filter((message) => readCompatibilityKind(message) !== null);
}

function readAgentMessageRows(id: string): AgentMessage[] {
  const filePath = getRuntimeCoreCompatibilityMessagesPath(id);
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AgentMessage);
  } catch (error) {
    console.error(`[Agent 会话] 读取消息失败 (${id}):`, error);
    backupCorruptFile(filePath, "Agent 会话消息");
    return [];
  }
}

function mergeTranscriptWithCompatibilityMessages(
  transcriptMessages: AgentMessage[],
  compatibilityMessages: AgentMessage[]
): AgentMessage[] {
  if (compatibilityMessages.length === 0) {
    return transcriptMessages;
  }
  const merged = [...transcriptMessages];
  for (const message of compatibilityMessages) {
    const compatibilityKind = readCompatibilityKind(message);
    if (compatibilityKind === "subagent_announce") {
      merged.push(stripCompatibilityKind(message));
      continue;
    }
    if (compatibilityKind === "message_metadata_overlay") {
      mergeCompatibilityMetadataOverlay(merged, message);
    }
  }
  merged.sort((a, b) => a.createdAt - b.createdAt);
  return merged;
}

function mergeCompatibilityMetadataOverlay(
  transcriptMessages: AgentMessage[],
  compatibilityMessage: AgentMessage
): void {
  for (let index = transcriptMessages.length - 1; index >= 0; index -= 1) {
    const candidate = transcriptMessages[index];
    if (!candidate) continue;
    if (candidate.role !== compatibilityMessage.role) continue;
    if (candidate.content !== compatibilityMessage.content) continue;
    transcriptMessages[index] = {
      ...candidate,
      metadata: {
        ...(candidate.metadata ?? {}),
        ...stripCompatibilityMetadata(compatibilityMessage.metadata)
      }
    };
    return;
  }
  transcriptMessages.push(stripCompatibilityKind(compatibilityMessage));
}

function withCompatibilityKind(message: AgentMessage, kind: AgentCompatibilityKind): AgentMessage {
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      __lumeCompatibilityKind: kind
    }
  };
}

function readCompatibilityKind(message: AgentMessage): AgentCompatibilityKind | null {
  const metadata = message.metadata as AgentCompatibilityMetadata | undefined;
  const kind = metadata?.__lumeCompatibilityKind;
  return kind === "subagent_announce" || kind === "message_metadata_overlay" ? kind : null;
}

function stripCompatibilityKind(message: AgentMessage): AgentMessage {
  const metadata = stripCompatibilityMetadata(message.metadata);
  return {
    ...message,
    ...(metadata ? { metadata } : {})
  };
}

function stripCompatibilityMetadata(
  metadata: AgentMessage["metadata"]
): AgentMessage["metadata"] | undefined {
  if (!metadata) return undefined;
  const { __lumeCompatibilityKind: _kind, ...rest } = metadata as AgentCompatibilityMetadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
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
