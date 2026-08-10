
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentMessage,
  AgentModelSelectionSource,
  AgentRecentMessagesResult,
  AgentThreadMeta,
  SDKMessage
} from "@lume/shared";
import {
  getAgentSessionDataDir,
  getAgentFileContextArtifactsPath,
  getAgentFileContextFilesPath,
  getAgentFileContextPlansPath,
  getAgentFileContextRootPath,
  getAgentFileContextSystemContextPath,
  getAgentThreadMessagesPath,
  getAgentWorkspacesDir,
  getAgentWorkspacePath,
  getAgentSessionsIndexPath
} from "../infra/config-paths";
import { withIndexMutationLock } from "../infra/index-mutation-lock";
import { ensureWorkspaceAgentAssets, getAgentWorkspace } from "./agent-workspace-manager";
import { getAgentSubmissionStore } from "./agent-submission-store";
import { getPlanningTodoStore } from "../planning/planning-todo-store";
import { agentLifecycleLocks } from "./agent-lifecycle-lock-manager";
import {
  getVisibleAgentMessages,
  syncVersionStoreFromMessages
} from "./agent-message-versioning-service";
import { readAgentMessageVersionStore, resetAgentMessageVersionStore } from "./agent-message-version-store";
import { resolveAgentDefaultStrategy } from "../channel/model-selection";
import { extractAssistantReasoningText, extractRenderableAssistantText } from "./content-extraction";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDirPath,
  hasRuntimeCoreSessionTranscript
} from "../agent-runtime/runtime-core/session-store";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { createLogger } from "../infra/logger";

interface AgentThreadsIndex {
  version: number;
  threads: AgentThreadMeta[];
}

const INDEX_VERSION = 1;
const log = createLogger("agent-thread-manager");

type FileContextMode = "newRoot" | "inherit" | "fork";

interface CreateAgentThreadOptions {
  fileContextMode?: FileContextMode;
  fileContextId?: string;
  wikiProfile?: AgentThreadMeta["wikiProfile"];
  memoryProfile?: AgentThreadMeta["memoryProfile"];
  planningOperationId?: string;
  planningTodoId?: string;
}

function buildModelRef(channelId?: string, modelId?: string): string | undefined {
  const trimmedChannelId = channelId?.trim();
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) {
    return undefined;
  }
  if (trimmedModelId.includes("/")) {
    return trimmedModelId;
  }
  if (!trimmedChannelId) {
    return undefined;
  }
  return `${trimmedChannelId}/${trimmedModelId}`;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveInheritedThreadSelection(workspaceId?: string): {
  channelId?: string;
  modelRef?: string;
} {
  const workspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined;
  const resolvedSelection = resolveAgentDefaultStrategy({
    globalDefault: getEffectiveLumeConfig(workspaceSlug).models?.agent
  });
  return {
    channelId: resolvedSelection.channelId,
    modelRef: resolvedSelection.modelRef
  };
}

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
    log.warn("backed up corrupt thread file", { label, backupPath });
  } catch (error) {
    log.warn("failed to back up corrupt thread file", { label, backupPath, error });
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
    log.error("failed to read thread index", { error, indexPath });
    backupCorruptFile(indexPath, "Agent 线程");
    return { version: INDEX_VERSION, threads: [] };
  }
}

function writeIndex(index: AgentThreadsIndex): void {
  const indexPath = getAgentSessionsIndexPath();
  try {
    writeTextAtomic(indexPath, JSON.stringify(index, null, 2));
  } catch (error) {
    log.error("failed to write thread index", { error, indexPath });
    throw new Error("写入 Agent 线程索引失败");
  }
}

function threadIndexLockPath(): string {
  return `${getAgentSessionsIndexPath()}.lock`;
}

function withThreadIndexMutation<T>(fn: (index: AgentThreadsIndex) => T): T {
  return withIndexMutationLock(threadIndexLockPath(), () => fn(readIndex()));
}

function resolveFileContextId(input: {
  threadId: string;
  parentThreadId?: string;
  mode?: FileContextMode;
  explicitFileContextId?: string;
  index: AgentThreadsIndex;
}): string {
  if (input.explicitFileContextId?.trim()) {
    return input.explicitFileContextId.trim();
  }
  if (input.mode === "inherit") {
    if (!input.parentThreadId) {
      throw new Error("fileContextMode=inherit 需要 parentThreadId");
    }
    const parent = input.index.threads.find((thread) => thread.id === input.parentThreadId);
    if (!parent) {
      throw new Error(`父线程不存在: ${input.parentThreadId}`);
    }
    return parent.fileContextId?.trim() || parent.id;
  }
  if (input.mode === "fork") {
    return randomUUID();
  }
  return input.threadId;
}

function ensureLumeFileContext(fileContextId: string): void {
  getAgentFileContextRootPath(fileContextId);
  getAgentFileContextFilesPath(fileContextId);
  getAgentFileContextPlansPath(fileContextId);
  getAgentFileContextArtifactsPath(fileContextId);
  getAgentFileContextSystemContextPath(fileContextId);
}

export function listAgentThreads(): AgentThreadMeta[] {
  return readIndex().threads
    .filter((t) => !t.status || t.status === "active")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listAllAgentThreads(): AgentThreadMeta[] {
  return readIndex().threads.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── Thread list change notification (pub/sub) ───
// listAgentThreads 结果变更后（创建/归档/删除等）广播给订阅者；
// sidecar 层订阅后经 writeNotification(THREAD_LIST_CHANGED) 推送前端刷新缓存，
// 使"子会话创建即同步显示"等场景不再依赖母会话 MESSAGE_APPENDED 的副作用刷新。
const threadListChangedListeners = new Set<() => void>();

function notifyThreadListChanged(): void {
  for (const listener of threadListChangedListeners) {
    try {
      listener();
    } catch {
      // 忽略单个 listener 失败，避免影响其他订阅者与主流程
    }
  }
}

export function subscribeThreadListChanged(listener: () => void): () => void {
  threadListChangedListeners.add(listener);
  return () => {
    threadListChangedListeners.delete(listener);
  };
}

export function getAgentThreadMeta(id: string): AgentThreadMeta | undefined {
  return readIndex().threads.find((thread) => thread.id === id);
}


export function createAgentThread(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  parentThreadId?: string,
  modelId?: string,
  options?: CreateAgentThreadOptions
): AgentThreadMeta {
  return createAgentThreadWithModelRef(title, undefined, channelId, workspaceId, parentThreadId, modelId, options);
}

export function broadcastAgentThreadListChanged(): void {
  notifyThreadListChanged();
}

export function createAgentThreadWithModelRef(
  title?: string,
  modelRef?: string,
  channelId?: string,
  workspaceId?: string,
  parentThreadId?: string,
  modelId?: string,
  options?: CreateAgentThreadOptions
): AgentThreadMeta {
  const meta = withThreadIndexMutation((index) => {
    const now = Date.now();
    const id = randomUUID();
    const explicitSelectionProvided = [modelRef, channelId, modelId]
      .some((value) => typeof value === "string" && value.trim().length > 0);
    const inheritedSelection = explicitSelectionProvided
      ? null
      : resolveInheritedThreadSelection(workspaceId);
    const fileContextId = resolveFileContextId({
      threadId: id,
      parentThreadId,
      mode: options?.fileContextMode ?? "newRoot",
      explicitFileContextId: options?.fileContextId,
      index
    });

    const next: AgentThreadMeta = {
      id,
      title: title || "新 Agent 线程",
      modelRef: explicitSelectionProvided
        ? modelRef ?? buildModelRef(channelId, modelId)
        : inheritedSelection?.modelRef,
      channelId: explicitSelectionProvided
        ? channelId
        : inheritedSelection?.channelId,
      modelId,
      modelSelectionSource: explicitSelectionProvided ? "thread-override" : "inherited",
      workspaceId,
      wikiProfile: options?.wikiProfile,
      memoryProfile: options?.memoryProfile,
      ...(options?.planningOperationId ? { createdByPlanningOperationId: options.planningOperationId } : {}),
      ...(options?.planningTodoId ? { planningTodoId: options.planningTodoId } : {}),
      fileContextId,
      parentThreadId,
      pinned: false,
      createdAt: now,
      updatedAt: now
    };

    index.threads.push(next);
    writeIndex(index);
    return next;
  });

  ensureLumeFileContext(meta.fileContextId ?? meta.id);
  if (workspaceId) {
    const workspace = getAgentWorkspace(workspaceId);
    if (workspace) {
      ensureWorkspaceAgentAssets(workspace.slug, workspace.name);
    }
  }

  log.info("created agent thread", { threadId: meta.id, workspaceId: meta.workspaceId });
  notifyThreadListChanged();
  return meta;
}

export function getAgentThreadMessages(id: string): AgentMessage[] {
  const existingStore = readAgentMessageVersionStore(id);
  if (existingStore && existingStore.visibleGroupIds.length > 0) {
    return getVisibleAgentMessages(id);
  }
  const transcriptMessages = readRuntimeCoreTranscriptMessages(id);
  syncVersionStoreFromMessages(id, transcriptMessages);
  return getVisibleAgentMessages(id);
}

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
      log.error("failed to read SDK messages", { error, threadId: id });
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
    log.error("failed to append SDK message", { error, threadId: id });
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
    log.error("failed to append transcript message", { error, threadId: id });
    throw new Error("追加 Agent transcript 消息失败");
  }
}

type AgentThreadMetaUpdates = Partial<
  Pick<
    AgentThreadMeta,
    "title" | "sdkThreadId" | "runtimeThreadId" | "workspaceId" | "fileContextId" | "source" | "pinned" | "parentThreadId" | "modelSelectionSource" | "status" | "trashedAt"
  >
> & {
  modelRef?: string | null;
  channelId?: string | null;
  modelId?: string | null;
};

/**
 * 非致命版本：线程索引条目缺失时返回 null，而非抛出。
 *
 * 用于标题、模型选择等“非关键元数据”写入——这些不应让整次运行失败。
 * 条目缺失的根因是跨进程对 agent-sessions.json 的 read-modify-write 丢更新
 * （多 sidecar 实例短暂重叠），会让自动化任务以 “Agent 线程不存在” 失败。
 */
export function tryUpdateAgentThreadMeta(
  id: string,
  updates: AgentThreadMetaUpdates
): AgentThreadMeta | null {
  return withThreadIndexMutation((index) => {
    const idx = index.threads.findIndex((thread) => thread.id === id);
    if (idx === -1) {
      return null;
    }

    const existing = index.threads[idx] as AgentThreadMeta;
    const nextChannelId = hasOwn(updates, "channelId")
      ? updates.channelId ?? undefined
      : existing.channelId;
    const nextModelId = hasOwn(updates, "modelId")
      ? updates.modelId ?? undefined
      : existing.modelId;
    const touchedSelection = hasOwn(updates, "modelRef") || hasOwn(updates, "channelId") || hasOwn(updates, "modelId");
    const nextModelRef = touchedSelection
      ? hasOwn(updates, "modelRef")
        ? updates.modelRef ?? undefined
        : buildModelRef(nextChannelId, nextModelId)
      : existing.modelRef;
    const updated: AgentThreadMeta = {
      ...existing,
      ...updates,
      channelId: nextChannelId,
      modelId: nextModelId,
      modelRef: nextModelRef,
      modelSelectionSource: hasOwn(updates, "modelSelectionSource")
        ? updates.modelSelectionSource ?? undefined
        : existing.modelSelectionSource,
      updatedAt: Date.now()
    };

    index.threads[idx] = updated;
    writeIndex(index);

    log.info("updated agent thread", { threadId: updated.id });
    return updated;
  });
}

export function updateAgentThreadMeta(
  id: string,
  updates: AgentThreadMetaUpdates
): AgentThreadMeta {
  const updated = tryUpdateAgentThreadMeta(id, updates);
  if (!updated) {
    throw new Error(`Agent 线程不存在: ${id}`);
  }
  return updated;
}

export function toggleAgentThreadPin(id: string): AgentThreadMeta {
  const meta = getAgentThreadMeta(id);
  if (!meta) {
    throw new Error(`Agent 线程不存在: ${id}`);
  }
  return updateAgentThreadMeta(id, { pinned: !meta.pinned });
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
  ensureLumeFileContext(currentMeta.fileContextId ?? currentMeta.id);

  return updateAgentThreadMeta(id, {
    workspaceId: workspaceId,
    sdkThreadId: undefined,
    runtimeThreadId: undefined
  });
}

export function deleteAgentThread(id: string): void {
  const threadBeforeDelete = getAgentThreadMeta(id);
  const workspaceLock = `workspace:${threadBeforeDelete?.workspaceId ?? "<unassigned>"}`;
  const release = agentLifecycleLocks.tryAcquire([workspaceLock, `thread:${id}`]);
  if (!release) throw new Error("Agent 线程正在执行项目生命周期操作，请稍后重试");
  try { deleteAgentThreadLocked(id); } finally { release(); }
}

function deleteAgentThreadLocked(id: string): void {
  const planningStore = getPlanningTodoStore();
  const linkSnapshot = planningStore.snapshotThreadLinks(id);
  const operationId = randomUUID();
  planningStore.reserveOperation({ operationId, kind: "thread_delete", threadId: id });
  // Planning links are tombstoned before the external thread index mutation.
  planningStore.tombstoneThreadLinks(id);
  planningStore.advanceOperation(operationId, { phase: "links_tombstoned", status: "running", threadId: id });
  let removed: AgentThreadMeta;
  let fileContextId: string;
  let deleteFileContext: boolean;
  try {
    ({ removed, fileContextId, deleteFileContext } = withThreadIndexMutation((index) => {
    const idx = index.threads.findIndex((thread) => thread.id === id);
    if (idx === -1) {
      throw new Error(`Agent 线程不存在: ${id}`);
    }

    const removed = index.threads.splice(idx, 1)[0] as AgentThreadMeta;
    const fileContextId = removed.fileContextId ?? removed.id;
    const deleteFileContext = !index.threads.some((thread) => (thread.fileContextId ?? thread.id) === fileContextId);
    writeIndex(index);
    return { removed, fileContextId, deleteFileContext };
    }));
    planningStore.advanceOperation(operationId, { phase: "index_removed", status: "running", threadId: id });
  } catch (error) {
    try {
      planningStore.restoreThreadLinkSnapshot(linkSnapshot);
      planningStore.advanceOperation(operationId, { phase: "compensating", status: "running", compensation: "pending", threadId: id, error: error instanceof Error ? error.message : String(error) });
      planningStore.advanceOperation(operationId, { phase: "finalized", status: "failed", recoverable: false, compensation: "completed", threadId: id, error: error instanceof Error ? error.message : String(error) });
    } catch (compensationError) {
      planningStore.advanceOperation(operationId, { phase: "compensating", status: "partial", recoverable: true, compensation: "failed", threadId: id, error: compensationError instanceof Error ? compensationError.message : String(compensationError) });
    }
    throw error;
  }

  let cleanupPending = false;

  try {
    const workspacesDir = getAgentWorkspacesDir();
    const workspaceEntries = readdirSync(workspacesDir, { withFileTypes: true });
    for (const entry of workspaceEntries) {
      if (!entry.isDirectory()) continue;
      const threadDir = join(workspacesDir, entry.name, id);
      if (!existsSync(threadDir)) continue;
      rmSync(threadDir, { recursive: true, force: true });
      log.debug("removed thread working directory", { threadId: id, threadDir });
    }
  } catch (error) {
    cleanupPending = true;
    log.warn("failed to remove thread working directory", { error, threadId: id });
  }

  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(id);
  if (existsSync(runtimeCoreSessionDir)) {
    try {
      rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
      log.debug("removed runtime-core transcript", { threadId: id, runtimeCoreSessionDir });
    } catch (error) {
      cleanupPending = true;
      log.warn("failed to remove runtime-core transcript", { error, threadId: id });
    }
  }

  const sessionDataDir = getAgentSessionDataDir(id);
  if (existsSync(sessionDataDir)) {
    try {
      rmSync(sessionDataDir, { recursive: true, force: true });
      log.debug("removed thread version data", { threadId: id, sessionDataDir });
    } catch (error) {
      cleanupPending = true;
      log.warn("failed to remove thread version data", { error, threadId: id });
    }
  }

  if (deleteFileContext) {
    withThreadIndexMutation((index) => {
      const stillReferenced = index.threads.some((thread) => (thread.fileContextId ?? thread.id) === fileContextId);
      if (stillReferenced) return;
      const contextDir = getAgentFileContextRootPath(fileContextId);
      if (existsSync(contextDir)) {
        try {
          rmSync(contextDir, { recursive: true, force: true });
          log.debug("removed file context directory", { threadId: id, fileContextId, contextDir });
        } catch (error) {
          cleanupPending = true;
          log.warn("failed to remove file context directory", { error, threadId: id, fileContextId });
        }
      }
    });
  }

  getAgentSubmissionStore().deleteThread(id);
  if (cleanupPending) {
    planningStore.advanceOperation(operationId, { phase: "cleanup_pending", status: "partial", recoverable: true, threadId: id, error: "thread file cleanup pending" });
  } else {
    planningStore.advanceOperation(operationId, { phase: "files_removed", status: "running", threadId: id });
    planningStore.advanceOperation(operationId, { phase: "finalized", status: "completed", recoverable: false, threadId: id });
  }
  log.info("deleted agent thread", { threadId: removed.id });
}

export function listAgentThreadsForWorkspace(workspaceId: string): AgentThreadMeta[] {
  return readIndex().threads.filter((thread) => thread.workspaceId === workspaceId);
}

export function invalidateAgentThreadRuntimeState(threadId: string): void {
  const messages = getAgentThreadMessages(threadId);
  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(threadId);
  if (existsSync(runtimeCoreSessionDir)) {
    rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
  }
  resetAgentMessageVersionStore(threadId);
  rebuildThreadSDKTranscript(threadId, messages);
  syncVersionStoreFromMessages(threadId, messages);
  updateAgentThreadMeta(threadId, {
    sdkThreadId: undefined,
    runtimeThreadId: undefined
  });
}

export function clearWorkspaceFromAgentThreads(workspaceId: string): AgentThreadMeta[] {
  const updated = withThreadIndexMutation((index) => {
    const now = Date.now();
    const changed: AgentThreadMeta[] = [];
    for (let i = 0; i < index.threads.length; i += 1) {
      const thread = index.threads[i] as AgentThreadMeta;
      if (thread.workspaceId !== workspaceId) continue;
      const next: AgentThreadMeta = {
        ...thread,
        workspaceId: undefined,
        sdkThreadId: undefined,
        runtimeThreadId: undefined,
        updatedAt: now
      };
      index.threads[i] = next;
      changed.push(next);
    }
    if (changed.length > 0) {
      writeIndex(index);
    }
    return changed;
  });
  if (updated.length > 0) {
    notifyThreadListChanged();
  }
  return updated;
}

export function trashAgentThreads(threadIds: Set<string>): AgentThreadMeta[] {
  const planningStore = getPlanningTodoStore();
  for (const threadId of threadIds) planningStore.markThreadLinksTrashed(threadId);
  const trashed = withThreadIndexMutation((index) => {
    const now = Date.now();
    const changed: AgentThreadMeta[] = [];
    for (let i = 0; i < index.threads.length; i += 1) {
      const thread = index.threads[i] as AgentThreadMeta;
      if (!threadIds.has(thread.id)) continue;
      const next: AgentThreadMeta = {
        ...thread,
        status: "trashed",
        trashedAt: now,
        workspaceId: undefined,
        sdkThreadId: undefined,
        runtimeThreadId: undefined,
        updatedAt: now
      };
      index.threads[i] = next;
      changed.push(next);
    }
    if (changed.length > 0) {
      writeIndex(index);
    }
    return changed;
  });
  if (trashed.length > 0) {
    notifyThreadListChanged();
  }
  return trashed;
}

// ===== 归档与回收站 =====

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export function listArchivedThreads(): AgentThreadMeta[] {
  return readIndex().threads
    .filter((t) => t.status === "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listTrashedThreads(): AgentThreadMeta[] {
  return readIndex().threads
    .filter((t) => t.status === "trashed")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function archiveAgentThread(id: string): AgentThreadMeta {
  log.info("archived agent thread", { threadId: id });
  const archived = updateAgentThreadMeta(id, { status: "archived" });

  // ★ D8: 级联归档委托子会话（delegate 仅一级，无孙会话，递归调用自身安全）
  // 子会话在父归档时仍为 active，可通过 listAgentThreads 取得。
  const childThreads = listAgentThreads().filter((t) => t.parentThreadId === id);
  for (const child of childThreads) {
    archiveAgentThread(child.id);
  }

  return archived;
}

export function restoreAgentThread(id: string): AgentThreadMeta {
  log.info("restored agent thread from archive", { threadId: id });
  return updateAgentThreadMeta(id, { status: undefined, trashedAt: undefined });
}

export function trashAgentThread(id: string): AgentThreadMeta {
  log.info("moved agent thread to trash", { threadId: id });
  return updateAgentThreadMeta(id, { status: "trashed", trashedAt: Date.now() });
}

export function restoreAgentThreadFromTrash(id: string): AgentThreadMeta {
  const meta = getAgentThreadMeta(id);
  const shouldClearWorkspace = Boolean(meta?.workspaceId && !getAgentWorkspace(meta.workspaceId));
  return updateAgentThreadMeta(id, {
    status: "archived",
    trashedAt: undefined,
    ...(shouldClearWorkspace ? { workspaceId: undefined, sdkThreadId: undefined, runtimeThreadId: undefined } : {})
  });
}

export function permanentlyDeleteAgentThread(id: string): void {
  deleteAgentThread(id);
}

/** 清理回收站中超过 30 天的线程，返回清理数量 */
export function cleanupExpiredTrash(): number {
  const index = readIndex();
  const now = Date.now();
  const toDelete = index.threads.filter(
    (t) => t.status === "trashed" && t.trashedAt && (now - t.trashedAt) > TRASH_RETENTION_MS
  );

  for (const thread of toDelete) {
    deleteAgentThread(thread.id);
  }

  if (toDelete.length > 0) {
    log.info("cleaned expired trashed threads", { count: toDelete.length });
  }
  return toDelete.length;
}

/** 清空回收站：永久删除所有 status === "trashed" 的线程（不限时间），返回清理数量 */
export function emptyTrash(): number {
  const index = readIndex();
  const toDelete = index.threads.filter((t) => t.status === "trashed");

  for (const thread of toDelete) {
    deleteAgentThread(thread.id);
  }

  if (toDelete.length > 0) {
    log.info("emptied thread trash", { count: toDelete.length });
  }
  return toDelete.length;
}

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

/** 保留目标消息及其之前的消息，用于 Coding Turn 完整回退。 */
export function truncateAgentMessagesAfter(threadId: string, messageId: string): {
  messages: AgentMessage[];
  removed: number;
} {
  const messages = getAgentThreadMessages(threadId);
  const targetIndex = messages.findIndex((msg) => msg.id === messageId);
  if (targetIndex === -1) {
    throw new Error(`消息 ${messageId} 在线程 ${threadId} 中未找到`);
  }
  const kept = messages.slice(0, targetIndex + 1);
  replaceAgentThreadTranscript(threadId, kept);
  return { messages: kept, removed: messages.length - kept.length };
}

/**
 * 清空指定线程的全部消息与运行记录，保留线程本身（meta 留存），可在同一会话窗口继续对话。
 * 先停止运行中的线程再清空，避免 runtime 在清空后继续写入。
 * stopAgent 对非运行中的线程为幂等 no-op。
 * 动态 import agent-service 以规避与 agent-service 的静态循环依赖（agent-service 已反向 import 本模块）。
 */
export async function clearAgentThreadMessages(threadId: string): Promise<{ ok: true; cleared: number }> {
  const { stopAgent } = await import("./agent-service");
  await stopAgent(threadId);
  const messages = getAgentThreadMessages(threadId);
  replaceAgentThreadTranscript(threadId, []);
  log.info("cleared thread messages", { threadId, count: messages.length });
  return { ok: true, cleared: messages.length };
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
    sourceMeta?.modelId,
    { fileContextMode: "fork" }
  );

  replaceAgentThreadTranscript(newThread.id, forkedMessages);

  log.info("forked agent thread", { sourceThreadId, threadId: newThread.id, messageCount: forkedMessages.length });
  return { newThreadId: newThread.id };
}

export function replaceAgentThreadTranscript(threadId: string, messages: AgentMessage[]): void {
  const runtimeCoreSessionDir = getRuntimeCoreSessionDirPath(threadId);
  if (existsSync(runtimeCoreSessionDir)) {
    rmSync(runtimeCoreSessionDir, { recursive: true, force: true });
  }
  resetAgentMessageVersionStore(threadId);
  rebuildRuntimeCoreTranscript(threadId, messages);
  rebuildThreadSDKTranscript(threadId, messages);
  syncVersionStoreFromMessages(threadId, messages);
  updateAgentThreadMeta(threadId, {
    sdkThreadId: undefined,
    runtimeThreadId: undefined
  });
}

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

      const projected: AgentMessage = {
        id: turnId,
        role: message.role,
        content,
        ...(reasoning ? { reasoning } : {}),
        createdAt: resolveRuntimeCoreMessageTimestamp(message, index),
        model: message.role === "assistant" ? resolveRuntimeCoreMessageModel(message) : undefined,
        sdkMessages: [message.role === "assistant" ? toSdkAssistantMessage(message, turnId) : toSdkUserMessage(message, turnId)]
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

function resolveAgentThreadCwd(threadId: string): string {
  try {
    return getAgentFileContextRootPath(getAgentThreadMeta(threadId)?.fileContextId ?? threadId);
  } catch {
    return process.cwd();
  }
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
