"use client";

import {
  AGENT_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
  CHAT_IPC_CHANNELS
} from "@lume/shared";
import type {
  AttachmentSaveInput,
  AttachmentSaveResult,
  AgentGenerateTitleInput,
  AgentMessage,
  AgentSaveFilesInput,
  AgentSavedFile,
  AgentSendInput,
  AgentSessionMeta,
  AgentStreamEvent,
  AgentWorkspace,
  FileEntry,
  FileDialogResult,
  AgentCopyFolderInput,
  Channel,
  ChannelCreateInput,
  ChannelTestResult,
  ChannelUpdateInput,
  ChatMessage,
  ChatSendInput,
  ConversationMeta,
  FetchModelsInput,
  FetchModelsResult,
  GenerateTitleInput,
  HealthcheckResult,
  RecentMessagesResult,
  StreamChunkEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamReasoningEvent,
  WorkspaceCapabilities,
  WorkspaceMcpConfig
} from "@lume/shared";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const SIDECAR_CALL_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} 超时 (${timeoutMs}ms)`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export async function desktopHealthcheck(): Promise<HealthcheckResult> {
  try {
    const result = await invoke<HealthcheckResult>("healthcheck");
    return result;
  } catch {
    return {
      ok: true,
      source: "web"
    };
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke("open_external", { url });
}

export async function sidecarHealthcheck(): Promise<HealthcheckResult> {
  try {
    const result = await invoke<HealthcheckResult>("sidecar_healthcheck");
    return result;
  } catch {
    return {
      ok: true,
      source: "web"
    };
  }
}

export async function sidecarCall<T>(method: string, params?: unknown): Promise<T> {
  const invokeOnce = (): Promise<T> =>
    withTimeout(
      invoke<T>("sidecar_call", {
        method,
        params: params ?? null
      }),
      SIDECAR_CALL_TIMEOUT_MS,
      `sidecar_call(${method})`
    );

  try {
    return await invokeOnce();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetry = message.includes("超时") || message.includes("sidecar is not running");
    if (!shouldRetry) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return invokeOnce();
  }
}

export type SidecarNotification = {
  method: string;
  params: unknown;
};

export async function onSidecarEvent(
  handler: (event: SidecarNotification) => void
): Promise<UnlistenFn> {
  try {
    return await listen<SidecarNotification>("sidecar:event", (event) => {
      handler(event.payload);
    });
  } catch (error) {
    console.error("[desktop-api] 订阅 sidecar:event 失败:", error);
    return async () => {};
  }
}

type SidecarMethod = string;

export async function onSidecarMethodEvent(
  method: SidecarMethod,
  handler: (params: unknown) => void
): Promise<UnlistenFn> {
  return onSidecarEvent((event) => {
    if (event.method === method) {
      handler(event.params);
    }
  });
}

export async function listChannels(): Promise<Channel[]> {
  return sidecarCall<Channel[]>(CHANNEL_IPC_CHANNELS.LIST);
}

export async function createChannel(input: ChannelCreateInput): Promise<Channel> {
  return sidecarCall<Channel>(CHANNEL_IPC_CHANNELS.CREATE, input);
}

export async function updateChannel(id: string, input: ChannelUpdateInput): Promise<Channel> {
  return sidecarCall<Channel>(CHANNEL_IPC_CHANNELS.UPDATE, { id, input });
}

export async function deleteChannel(id: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHANNEL_IPC_CHANNELS.DELETE, { id });
}

export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  return sidecarCall<ChannelTestResult>(CHANNEL_IPC_CHANNELS.TEST, { channelId });
}

export async function decryptChannelApiKey(channelId: string): Promise<string> {
  return sidecarCall<string>(CHANNEL_IPC_CHANNELS.DECRYPT_KEY, { channelId });
}

export async function testChannelDirect(input: FetchModelsInput): Promise<ChannelTestResult> {
  return sidecarCall<ChannelTestResult>(CHANNEL_IPC_CHANNELS.TEST_DIRECT, input);
}

export async function fetchChannelModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  return sidecarCall<FetchModelsResult>(CHANNEL_IPC_CHANNELS.FETCH_MODELS, input);
}

export async function listConversations(): Promise<ConversationMeta[]> {
  return sidecarCall<ConversationMeta[]>(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS);
}

export async function createConversation(params?: {
  title?: string;
  modelId?: string;
  channelId?: string;
}): Promise<ConversationMeta> {
  return sidecarCall<ConversationMeta>(CHAT_IPC_CHANNELS.CREATE_CONVERSATION, params ?? {});
}

export async function getConversationMessages(conversationId: string): Promise<ChatMessage[]> {
  return sidecarCall<ChatMessage[]>(CHAT_IPC_CHANNELS.GET_MESSAGES, { conversationId });
}

export async function getRecentConversationMessages(
  conversationId: string,
  limit: number
): Promise<RecentMessagesResult> {
  return sidecarCall<RecentMessagesResult>(CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES, {
    conversationId,
    limit
  });
}

export async function updateConversationTitle(conversationId: string, title: string): Promise<ConversationMeta> {
  return sidecarCall<ConversationMeta>(CHAT_IPC_CHANNELS.UPDATE_TITLE, { conversationId, title });
}

export async function deleteConversationById(conversationId: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHAT_IPC_CHANNELS.DELETE_CONVERSATION, { conversationId });
}

export async function updateConversationModel(
  conversationId: string,
  modelId?: string,
  channelId?: string
): Promise<ConversationMeta> {
  return sidecarCall<ConversationMeta>(CHAT_IPC_CHANNELS.UPDATE_MODEL, {
    conversationId,
    modelId,
    channelId
  });
}

export async function sendChatMessage(input: ChatSendInput): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHAT_IPC_CHANNELS.SEND_MESSAGE, input);
}

export async function stopChatGeneration(conversationId: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHAT_IPC_CHANNELS.STOP_GENERATION, { conversationId });
}

export async function deleteConversationMessage(
  conversationId: string,
  messageId: string
): Promise<ChatMessage[]> {
  return sidecarCall<ChatMessage[]>(CHAT_IPC_CHANNELS.DELETE_MESSAGE, { conversationId, messageId });
}

export async function truncateConversationMessagesFrom(
  conversationId: string,
  messageId: string,
  preserveFirstMessageAttachments = false
): Promise<ChatMessage[]> {
  return sidecarCall<ChatMessage[]>(CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM, {
    conversationId,
    messageId,
    preserveFirstMessageAttachments
  });
}

export async function updateConversationContextDividers(
  conversationId: string,
  dividers: string[]
): Promise<ConversationMeta> {
  return sidecarCall<ConversationMeta>(CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS, {
    conversationId,
    dividers
  });
}

export async function togglePinConversation(conversationId: string): Promise<ConversationMeta> {
  return sidecarCall<ConversationMeta>(CHAT_IPC_CHANNELS.TOGGLE_PIN, { conversationId });
}

export async function saveChatAttachment(input: AttachmentSaveInput): Promise<AttachmentSaveResult> {
  return sidecarCall<AttachmentSaveResult>(CHAT_IPC_CHANNELS.SAVE_ATTACHMENT, input);
}

export async function readChatAttachment(localPath: string): Promise<string> {
  return sidecarCall<string>(CHAT_IPC_CHANNELS.READ_ATTACHMENT, { localPath });
}

export async function deleteChatAttachment(localPath: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHAT_IPC_CHANNELS.DELETE_ATTACHMENT, { localPath });
}

export async function extractChatAttachmentText(localPath: string): Promise<string> {
  return sidecarCall<string>(CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT, { localPath });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] ?? "" : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

export async function openChatFileDialog(): Promise<FileDialogResult> {
  try {
    const nativeResult = await invoke<FileDialogResult>("open_file_dialog");
    if (nativeResult && Array.isArray(nativeResult.files)) {
      return nativeResult;
    }
  } catch {
    // Fall back to browser input for non-desktop environments.
  }

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = [
    "image/*",
    ".pdf,.txt,.md,.json,.csv,.xml,.html",
    ".doc,.docx,.xls,.xlsx,.ppt,.pptx",
    ".odt,.odp,.ods"
  ].join(",");

  return new Promise((resolve) => {
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      const parsed = await Promise.all(
        files.map(async (file) => ({
          filename: file.name,
          mediaType: file.type || "application/octet-stream",
          data: await readFileAsBase64(file),
          size: file.size
        }))
      );
      resolve({ files: parsed });
    };
    input.click();
  });
}

export async function openFolderDialog(): Promise<{ path: string | null }> {
  try {
    const result = await invoke<{ path: string | null }>("open_folder_dialog");
    if (result && "path" in result) {
      return result;
    }
  } catch {
    // Fall back to browser flow in caller.
  }
  return { path: null };
}

export async function generateConversationTitle(input: GenerateTitleInput): Promise<string | null> {
  return sidecarCall<string | null>(CHAT_IPC_CHANNELS.GENERATE_TITLE, input);
}

export async function onChatStreamChunk(handler: (event: StreamChunkEvent) => void): Promise<UnlistenFn> {
  return onSidecarMethodEvent(CHAT_IPC_CHANNELS.STREAM_CHUNK, (params) => {
    handler(params as StreamChunkEvent);
  });
}

export async function onChatStreamReasoning(
  handler: (event: StreamReasoningEvent) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(CHAT_IPC_CHANNELS.STREAM_REASONING, (params) => {
    handler(params as StreamReasoningEvent);
  });
}

export async function onChatStreamComplete(
  handler: (event: StreamCompleteEvent) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(CHAT_IPC_CHANNELS.STREAM_COMPLETE, (params) => {
    handler(params as StreamCompleteEvent);
  });
}

export async function onChatStreamError(handler: (event: StreamErrorEvent) => void): Promise<UnlistenFn> {
  return onSidecarMethodEvent(CHAT_IPC_CHANNELS.STREAM_ERROR, (params) => {
    handler(params as StreamErrorEvent);
  });
}

export async function listAgentSessions(): Promise<AgentSessionMeta[]> {
  return sidecarCall<AgentSessionMeta[]>(AGENT_IPC_CHANNELS.LIST_SESSIONS);
}

export async function createAgentSession(params?: {
  title?: string;
  channelId?: string;
  workspaceId?: string;
}): Promise<AgentSessionMeta> {
  return sidecarCall<AgentSessionMeta>(AGENT_IPC_CHANNELS.CREATE_SESSION, params ?? {});
}

export async function getAgentSessionMessages(sessionId: string) {
  return sidecarCall<AgentMessage[]>(AGENT_IPC_CHANNELS.GET_MESSAGES, { sessionId });
}

export async function updateAgentSessionTitle(sessionId: string, title: string): Promise<AgentSessionMeta> {
  return sidecarCall<AgentSessionMeta>(AGENT_IPC_CHANNELS.UPDATE_TITLE, { sessionId, title });
}

export async function deleteAgentSessionById(sessionId: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.DELETE_SESSION, { sessionId });
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

export async function updateAgentWorkspace(
  id: string,
  name: string
): Promise<AgentWorkspace> {
  return sidecarCall<AgentWorkspace>(AGENT_IPC_CHANNELS.UPDATE_WORKSPACE, { id, name });
}

export async function deleteAgentWorkspace(id: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, { id });
}

export async function getAgentWorkspaceCapabilities(
  workspaceSlug: string
): Promise<WorkspaceCapabilities> {
  return sidecarCall<WorkspaceCapabilities>(AGENT_IPC_CHANNELS.GET_CAPABILITIES, { workspaceSlug });
}

export async function getAgentWorkspaceMcpConfig(
  workspaceSlug: string
): Promise<WorkspaceMcpConfig> {
  return sidecarCall<WorkspaceMcpConfig>(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, { workspaceSlug });
}

export async function saveAgentWorkspaceMcpConfig(
  workspaceSlug: string,
  config: WorkspaceMcpConfig
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG, { workspaceSlug, config });
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

export async function sendAgentMessage(input: AgentSendInput): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SEND_MESSAGE, input);
}

export async function stopAgentRun(sessionId: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.STOP_AGENT, { sessionId });
}

export async function generateAgentSessionTitle(
  input: AgentGenerateTitleInput
): Promise<string | null> {
  return sidecarCall<string | null>(AGENT_IPC_CHANNELS.GENERATE_TITLE, input);
}

export async function onAgentStreamEvent(handler: (event: AgentStreamEvent) => void): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.STREAM_EVENT, (params) => {
    handler(params as AgentStreamEvent);
  });
}

export async function onAgentStreamComplete(
  handler: (event: { sessionId: string }) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.STREAM_COMPLETE, (params) => {
    handler(params as { sessionId: string });
  });
}

export async function onAgentStreamError(
  handler: (event: { sessionId: string; error: string }) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.STREAM_ERROR, (params) => {
    handler(params as { sessionId: string; error: string });
  });
}

export async function onAgentTitleUpdated(
  handler: (event: { sessionId: string; title: string }) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.TITLE_UPDATED, (params) => {
    handler(params as { sessionId: string; title: string });
  });
}

export async function onAgentCapabilitiesChanged(
  handler: () => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, () => {
    handler();
  });
}

export async function getAgentSessionPath(
  workspaceSlug: string,
  sessionId: string
): Promise<string> {
  return sidecarCall<string>(AGENT_IPC_CHANNELS.GET_SESSION_PATH, { workspaceSlug, sessionId });
}

export async function listAgentDirectory(
  workspaceSlug: string,
  sessionId: string,
  path?: string
): Promise<FileEntry[]> {
  return sidecarCall<FileEntry[]>(AGENT_IPC_CHANNELS.LIST_DIRECTORY, {
    workspaceSlug,
    sessionId,
    path
  });
}

export async function deleteAgentFile(
  workspaceSlug: string,
  sessionId: string,
  path: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.DELETE_FILE, {
    workspaceSlug,
    sessionId,
    path
  });
}

export async function openAgentFile(
  workspaceSlug: string,
  sessionId: string,
  path: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.OPEN_FILE, {
    workspaceSlug,
    sessionId,
    path
  });
}

export async function showAgentFileInFolder(
  workspaceSlug: string,
  sessionId: string,
  path: string
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SHOW_IN_FOLDER, {
    workspaceSlug,
    sessionId,
    path
  });
}

export async function saveFilesToAgentSession(
  input: AgentSaveFilesInput
): Promise<AgentSavedFile[]> {
  return sidecarCall<AgentSavedFile[]>(AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION, input);
}

export async function copyFolderToAgentSession(
  input: AgentCopyFolderInput
): Promise<AgentSavedFile[]> {
  return sidecarCall<AgentSavedFile[]>(AGENT_IPC_CHANNELS.COPY_FOLDER_TO_SESSION, input);
}
