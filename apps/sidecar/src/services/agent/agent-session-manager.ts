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
import type { AgentMessage, AgentRecentMessagesResult, AgentSessionMeta } from "@lume/shared";
import {
  getAgentWorkspacesDir,
  getAgentWorkspacePath,
  getAgentSessionWorkspacePath,
  getAgentSessionsIndexPath
} from "../config-paths";
import { ensureWorkspaceAgentAssets, getAgentWorkspace } from "./agent-workspace-manager";
import { getConversationMessages } from "../conversation-manager";
import { extractRenderableAssistantText } from "../pi-agent/content-extraction";
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
  return readRuntimeCoreTranscriptMessages(id);
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
        content: [{ type: "text", text: message.content }],
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
      const { provider, model } = resolveTranscriptAppendModel(message.model);
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
        content: [{ type: "text", text: message.content }],
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
        model: message.role === "assistant" ? resolveRuntimeCoreMessageModel(message) : undefined,
        ...(message.role === "assistant" ? deriveRuntimeCoreAssistantDecorations(content, message) : {})
      } satisfies AgentMessage];
    });
  return projectedMessages;
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
