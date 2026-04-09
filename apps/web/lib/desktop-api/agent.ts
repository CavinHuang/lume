import { AGENT_IPC_CHANNELS, MEMORY_IPC_CHANNELS } from "@lume/shared";
import type {
  AgentAskUserQuestionRequest,
  AgentMessageAppendedEvent,
  AgentAskUserQuestionResponseInput,
  AgentCopyFolderInput,
  AgentGenerateTitleInput,
  AgentListSubagentRunsInput,
  AgentListSubagentRunsResult,
  AgentMessage,
  AgentThreadSDKMessagesResult,
  AgentMessageVersionsResult,
  AgentProxySettings,
  AgentProxyStatus,
  AgentRecentMessagesResult,
  AgentRuntimeStatus,
  AgentThreadMeta,
  AgentRuntimeStatusChangedEvent,
  AgentRuntimeToolPolicyConfig,
  AgentSaveFilesInput,
  AgentSavedFile,
  AgentSendInput,
  AgentStreamEvent,
  AgentToolPermissionRequest,
  AgentToolPermissionResponseInput,
  AgentWorkspace,
  FileEntry,
  FileSearchResult,
  ForkThreadInput,
  ForkThreadResult,
  GlobalDiscoverySnapshot,
  GlobalImportResult,
  GlobalPluginMarketplaceDetail,
  ImportGlobalMcpToWorkspaceInput,
  ImportGlobalSkillToWorkspaceInput,
  InstallGlobalPluginInput,
  InstallGlobalPluginResult,
  MemorySearchResult,
  MemoryStats,
  PlanFileMeta,
  PlanStateChangedEvent,
  WorkspaceCapabilities,
  WorkspaceMcpConfig
} from "@lume/shared";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onSidecarMethodEvent, sidecarCall } from "./core";

export async function listAgentThreads(): Promise<AgentThreadMeta[]> {
  return sidecarCall<AgentThreadMeta[]>(AGENT_IPC_CHANNELS.LIST_THREADS);
}

export async function listSubagentRuns(
  input?: AgentListSubagentRunsInput
): Promise<AgentListSubagentRunsResult> {
  return sidecarCall<AgentListSubagentRunsResult>(AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS, input ?? {});
}

export async function getAgentThreadRuntimeStatus(threadId: string): Promise<AgentRuntimeStatus> {
  return sidecarCall<AgentRuntimeStatus>(AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS, { threadId: threadId });
}

export async function createAgentThread(params?: {
  title?: string;
  channelId?: string;
  modelId?: string;
  workspaceId?: string;
  parentThreadId?: string;
}): Promise<AgentThreadMeta> {
  return sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.CREATE_THREAD, {
    ...(params ?? {}),
    ...(params?.parentThreadId ? { parentThreadId: params.parentThreadId } : {})
  });
}

export async function getAgentThreadMessages(threadId: string): Promise<AgentMessage[]> {
  return sidecarCall<AgentMessage[]>(AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES, { threadId: threadId });
}

export async function getAgentThreadSDKMessages(threadId: string) {
  const result = await sidecarCall<AgentThreadSDKMessagesResult>(AGENT_IPC_CHANNELS.GET_THREAD_SDK_MESSAGES, {
    threadId
  });
  return result.messages;
}

export async function getAgentThreadMessageVersions(
  threadId: string,
  versionGroupId: string
): Promise<AgentMessage[]> {
  const result = await sidecarCall<AgentMessageVersionsResult>(AGENT_IPC_CHANNELS.GET_THREAD_MESSAGE_VERSIONS, {
    threadId: threadId,
    versionGroupId
  });
  return result.messages;
}

export async function getRecentAgentThreadMessages(threadId: string, limit: number): Promise<AgentRecentMessagesResult> {
  return sidecarCall<AgentRecentMessagesResult>(AGENT_IPC_CHANNELS.GET_RECENT_THREAD_MESSAGES, { threadId: threadId, limit });
}

export async function updateAgentThreadTitle(threadId: string, title: string): Promise<AgentThreadMeta> {
  return sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.UPDATE_THREAD_TITLE, { threadId: threadId, title });
}


export async function updateAgentThreadModelSelection(
  threadId: string,
  modelId?: string,
  channelId?: string
): Promise<AgentThreadMeta> {
  return sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION, {
    threadId: threadId,
    modelId,
    channelId
  });
}


export async function migrateChatToAgentThread(
  conversationId: string,
  threadId: string
): Promise<{ ok: true; migrated: number }> {
  return sidecarCall<{ ok: true; migrated: number }>(AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_THREAD, {
    conversationId,
    threadId: threadId
  });
}


export async function togglePinAgentThread(threadId: string): Promise<AgentThreadMeta> {
  return sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.TOGGLE_PIN_THREAD, { threadId: threadId });
}


export async function moveAgentThreadToWorkspace(
  threadId: string,
  workspaceId: string
): Promise<AgentThreadMeta> {
  return sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.MOVE_THREAD, { threadId: threadId, workspaceId });
}


export async function deleteAgentThreadById(threadId: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.DELETE_THREAD, { threadId: threadId });
}


export async function truncateAgentThreadMessagesFrom(
  threadId: string,
  messageId: string
): Promise<AgentMessage[]> {
  return sidecarCall<AgentMessage[]>(AGENT_IPC_CHANNELS.TRUNCATE_THREAD_MESSAGES_FROM, {
    threadId: threadId,
    messageId
  });
}

export async function listAgentWorkspaces(): Promise<AgentWorkspace[]> {
  return sidecarCall<AgentWorkspace[]>(AGENT_IPC_CHANNELS.LIST_WORKSPACES);
}

export async function createAgentWorkspace(name: string): Promise<AgentWorkspace> {
  return sidecarCall<AgentWorkspace>(AGENT_IPC_CHANNELS.CREATE_WORKSPACE, { name });
}

export async function ensureDefaultAgentWorkspace(): Promise<AgentWorkspace> {
  return sidecarCall<AgentWorkspace>("agent:ensure-default-workspace");
}

export async function updateAgentWorkspace(id: string, name: string): Promise<AgentWorkspace> {
  return sidecarCall<AgentWorkspace>(AGENT_IPC_CHANNELS.UPDATE_WORKSPACE, { id, name });
}

export async function deleteAgentWorkspace(id: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, { id });
}

export async function getAgentWorkspaceCapabilities(workspaceSlug: string): Promise<WorkspaceCapabilities> {
  return sidecarCall<WorkspaceCapabilities>(AGENT_IPC_CHANNELS.GET_CAPABILITIES, { workspaceSlug });
}

export async function getAgentWorkspaceMcpConfig(workspaceSlug: string): Promise<WorkspaceMcpConfig> {
  return sidecarCall<WorkspaceMcpConfig>(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, { workspaceSlug });
}

export async function saveAgentWorkspaceMcpConfig(
  workspaceSlug: string,
  config: WorkspaceMcpConfig
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG, { workspaceSlug, config });
}

export async function getAgentToolPolicyConfig(): Promise<AgentRuntimeToolPolicyConfig> {
  return sidecarCall<AgentRuntimeToolPolicyConfig>(AGENT_IPC_CHANNELS.GET_TOOL_POLICY);
}

export async function saveAgentToolPolicyConfig(
  input: AgentRuntimeToolPolicyConfig
): Promise<AgentRuntimeToolPolicyConfig> {
  return sidecarCall<AgentRuntimeToolPolicyConfig>(AGENT_IPC_CHANNELS.SAVE_TOOL_POLICY, input);
}

export async function getAgentProxySettings(): Promise<AgentProxyStatus> {
  return sidecarCall<AgentProxyStatus>(AGENT_IPC_CHANNELS.GET_PROXY_SETTINGS);
}

export async function saveAgentProxySettings(input: AgentProxySettings): Promise<AgentProxyStatus> {
  return sidecarCall<AgentProxyStatus>(AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS, input);
}

export async function listAgentWorkspaceSkills(
  workspaceSlug: string
): Promise<Array<{ slug: string; name: string; description?: string; icon?: string }>> {
  return sidecarCall<Array<{ slug: string; name: string; description?: string; icon?: string }>>(
    AGENT_IPC_CHANNELS.GET_SKILLS,
    { workspaceSlug }
  );
}

export async function deleteAgentWorkspaceSkill(
  workspaceSlug: string,
  skillSlug: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.DELETE_SKILL, { workspaceSlug, skillSlug });
}

export async function getAgentGlobalDiscoverySnapshot(): Promise<GlobalDiscoverySnapshot> {
  return sidecarCall<GlobalDiscoverySnapshot>(AGENT_IPC_CHANNELS.GET_GLOBAL_DISCOVERY);
}

export async function rescanAgentGlobalDiscoverySnapshot(): Promise<GlobalDiscoverySnapshot> {
  return sidecarCall<GlobalDiscoverySnapshot>(AGENT_IPC_CHANNELS.RESCAN_GLOBAL_DISCOVERY);
}

export async function getAgentGlobalMarketplaceDetail(
  marketplaceId: string
): Promise<GlobalPluginMarketplaceDetail> {
  return sidecarCall<GlobalPluginMarketplaceDetail>(AGENT_IPC_CHANNELS.GET_GLOBAL_MARKETPLACE_DETAIL, {
    marketplaceId
  });
}

export async function installAgentGlobalPlugin(
  input: InstallGlobalPluginInput
): Promise<InstallGlobalPluginResult> {
  return sidecarCall<InstallGlobalPluginResult>(AGENT_IPC_CHANNELS.INSTALL_GLOBAL_PLUGIN, input);
}

export async function importGlobalMcpToWorkspace(
  input: ImportGlobalMcpToWorkspaceInput
): Promise<GlobalImportResult> {
  return sidecarCall<GlobalImportResult>(AGENT_IPC_CHANNELS.IMPORT_GLOBAL_MCP_TO_WORKSPACE, input);
}

export async function importGlobalSkillToWorkspace(
  input: ImportGlobalSkillToWorkspaceInput
): Promise<GlobalImportResult> {
  return sidecarCall<GlobalImportResult>(AGENT_IPC_CHANNELS.IMPORT_GLOBAL_SKILL_TO_WORKSPACE, input);
}

export async function sendAgentThreadMessage(
  input: AgentSendInput & { threadId: string }
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE, {
    ...input,
    threadId: input.threadId
  });
}

export async function stopAgentThreadRun(threadId: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.STOP_THREAD, { threadId: threadId });
}

export async function generateAgentThreadTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return sidecarCall<string | null>(AGENT_IPC_CHANNELS.GENERATE_TITLE, input);
}

export async function onAgentStreamEvent(handler: (event: AgentStreamEvent) => void): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.STREAM_EVENT, (params) => {
    handler(params as AgentStreamEvent);
  });
}

export async function onAgentStreamError(
  handler: (event: { threadId: string; error: string }) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.STREAM_ERROR, (params) => {
    handler(params as { threadId: string; error: string });
  });
}

export async function onAgentRuntimeStatusChanged(
  handler: (event: AgentRuntimeStatusChangedEvent) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.RUNTIME_STATUS_CHANGED, (params) => {
    handler(params as AgentRuntimeStatusChangedEvent);
  });
}

export async function onAgentMessageAppended(
  handler: (event: AgentMessageAppendedEvent) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, (params) => {
    handler(params as AgentMessageAppendedEvent);
  });
}

export async function onAgentAskUserQuestion(
  handler: (event: AgentAskUserQuestionRequest) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, (params) => {
    handler(params as AgentAskUserQuestionRequest);
  });
}

export async function submitAgentAskUserQuestionAnswers(
  input: AgentAskUserQuestionResponseInput
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION, input);
}

export async function onAgentToolPermissionRequest(
  handler: (event: AgentToolPermissionRequest) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, (params) => {
    handler(params as AgentToolPermissionRequest);
  });
}

export async function submitAgentToolPermission(
  input: AgentToolPermissionResponseInput
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION, input);
}

export async function onAgentTitleUpdated(
  handler: (event: { threadId: string; title: string }) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.TITLE_UPDATED, (params) => {
    handler(params as { threadId: string; title: string });
  });
}

export async function onAgentCapabilitiesChanged(handler: () => void): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, () => {
    handler();
  });
}

export async function onAgentWorkspaceFilesChanged(handler: () => void): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, () => {
    handler();
  });
}

export async function getAgentThreadPath(
  workspaceSlug: string,
  threadId: string
): Promise<string> {
  return sidecarCall<string>(AGENT_IPC_CHANNELS.GET_THREAD_PATH, { workspaceSlug, threadId: threadId });
}

export async function listAgentDirectory(
  workspaceSlug: string,
  threadId: string,
  path?: string
): Promise<FileEntry[]> {
  return sidecarCall<FileEntry[]>(AGENT_IPC_CHANNELS.LIST_DIRECTORY, {
    workspaceSlug,
    threadId,
    path
  });
}

export async function deleteAgentFile(
  workspaceSlug: string,
  threadId: string,
  path: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.DELETE_FILE, {
    workspaceSlug,
    threadId,
    path
  });
}

export async function openAgentFile(
  workspaceSlug: string,
  threadId: string,
  path: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.OPEN_FILE, {
    workspaceSlug,
    threadId,
    path
  });
}

export async function showAgentFileInFolder(
  workspaceSlug: string,
  threadId: string,
  path: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SHOW_IN_FOLDER, {
    workspaceSlug,
    threadId,
    path
  });
}

export async function previewAgentFile(
  workspaceSlug: string,
  threadId: string,
  path: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.PREVIEW_FILE, {
    workspaceSlug,
    threadId,
    path
  });
}

export async function renameAgentFile(
  workspaceSlug: string,
  threadId: string,
  path: string,
  newName: string
): Promise<{ ok: true; path: string }> {
  return sidecarCall<{ ok: true; path: string }>(AGENT_IPC_CHANNELS.RENAME_FILE, {
    workspaceSlug,
    threadId,
    path,
    newName
  });
}

export async function moveAgentFile(
  workspaceSlug: string,
  threadId: string,
  path: string,
  targetDir: string
): Promise<{ ok: true; path: string }> {
  return sidecarCall<{ ok: true; path: string }>(AGENT_IPC_CHANNELS.MOVE_FILE, {
    workspaceSlug,
    threadId,
    path,
    targetDir
  });
}

export async function listAttachedDirectory(path: string): Promise<FileEntry[]> {
  return sidecarCall<FileEntry[]>(AGENT_IPC_CHANNELS.LIST_ATTACHED_DIRECTORY, { path });
}

export async function openAttachedFile(path: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.OPEN_ATTACHED_FILE, { path });
}

export async function showAttachedFileInFolder(path: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER, { path });
}

export async function renameAttachedFile(path: string, newName: string): Promise<{ ok: true; path: string }> {
  return sidecarCall<{ ok: true; path: string }>(AGENT_IPC_CHANNELS.RENAME_ATTACHED_FILE, {
    path,
    newName
  });
}

export async function moveAttachedFile(path: string, targetDir: string): Promise<{ ok: true; path: string }> {
  return sidecarCall<{ ok: true; path: string }>(AGENT_IPC_CHANNELS.MOVE_ATTACHED_FILE, {
    path,
    targetDir
  });
}

export async function getAgentWorkspaceRootPath(workspaceSlug: string): Promise<string> {
  return sidecarCall<string>(AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH, { workspaceSlug });
}

export async function searchAgentWorkspaceFiles(
  workspaceSlug: string,
  threadId: string,
  query: string,
  limit = 20,
  rootPath?: string
): Promise<FileSearchResult> {
  return sidecarCall<FileSearchResult>(AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES, {
    workspaceSlug,
    threadId,
    query,
    limit,
    rootPath
  });
}

export async function saveFilesToAgentThread(
  input: AgentSaveFilesInput & { threadId: string }
): Promise<AgentSavedFile[]> {
  return sidecarCall<AgentSavedFile[]>(AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD, {
    ...input,
    threadId: input.threadId
  });
}

export async function copyFolderToAgentThread(
  input: AgentCopyFolderInput & { threadId: string }
): Promise<AgentSavedFile[]> {
  return sidecarCall<AgentSavedFile[]>(AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD, {
    ...input,
    threadId: input.threadId
  });
}

export async function listAgentPlans(
  workspaceSlug: string | undefined,
  threadId: string
): Promise<PlanFileMeta[]> {
  return sidecarCall<PlanFileMeta[]>(AGENT_IPC_CHANNELS.LIST_PLANS, {
    ...(workspaceSlug ? { workspaceSlug } : {}),
    threadId
  });
}

export async function readAgentPlan(
  workspaceSlug: string | undefined,
  threadId: string,
  planPath: string
): Promise<{ path: string; content: string }> {
  return sidecarCall<{ path: string; content: string }>(AGENT_IPC_CHANNELS.READ_PLAN, {
    ...(workspaceSlug ? { workspaceSlug } : {}),
    threadId,
    planPath
  });
}

export async function deleteAgentPlan(
  workspaceSlug: string | undefined,
  threadId: string,
  planPath: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.DELETE_PLAN, {
    ...(workspaceSlug ? { workspaceSlug } : {}),
    threadId,
    planPath
  });
}

export async function onAgentPlanStateChanged(
  handler: (event: PlanStateChangedEvent) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.PLAN_STATE_CHANGED, (params) => {
    handler(params as PlanStateChangedEvent);
  });
}

export async function readAgentBootstrapFile(
  workspaceSlug: string,
  fileType: string
): Promise<{ content: string }> {
  return sidecarCall<{ content: string }>("agent:read-bootstrap-file", { workspaceSlug, fileType });
}

export async function writeAgentBootstrapFile(
  workspaceSlug: string,
  fileType: string,
  content: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>("agent:write-bootstrap-file", { workspaceSlug, fileType, content });
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface WriteLogInput {
  level?: LogLevel;
  context?: string;
  message: string;
  threadId?: string;
  data?: Record<string, unknown>;
}

export async function writeLog(input: WriteLogInput): Promise<{ ok: boolean }> {
  return sidecarCall<{ ok: boolean }>(AGENT_IPC_CHANNELS.WRITE_LOG, input);
}

export async function getLogsDir(): Promise<{ path: string }> {
  return sidecarCall<{ path: string }>(AGENT_IPC_CHANNELS.GET_LOGS_DIR);
}

export async function searchWorkspaceMemory(
  workspaceSlug: string,
  query: string,
  maxResults = 10
): Promise<MemorySearchResult[]> {
  return sidecarCall<MemorySearchResult[]>(MEMORY_IPC_CHANNELS.SEARCH, { workspaceSlug, query, maxResults });
}

export async function getWorkspaceMemoryStats(
  workspaceSlug: string
): Promise<MemoryStats> {
  return sidecarCall<MemoryStats>(MEMORY_IPC_CHANNELS.STATS, { workspaceSlug });
}

export const log = {
  debug: (message: string, data?: Record<string, unknown>, threadId?: string) =>
    writeLog({ level: "debug", message, data, threadId }),
  info: (message: string, data?: Record<string, unknown>, threadId?: string) =>
    writeLog({ level: "info", message, data, threadId }),
  warn: (message: string, data?: Record<string, unknown>, threadId?: string) =>
    writeLog({ level: "warn", message, data, threadId }),
  error: (message: string, data?: Record<string, unknown>, threadId?: string) =>
    writeLog({ level: "error", message, data, threadId })
};

// ─── 分叉 ───

export async function forkAgentThread(
  input: ForkThreadInput & { threadId: string }
): Promise<ForkThreadResult> {
  return sidecarCall<ForkThreadResult>(AGENT_IPC_CHANNELS.FORK_THREAD, {
    ...input,
    threadId: input.threadId
  });
}

