"use client";

import {
  CHAT_IPC_CHANNELS,
  CHAT_TOOL_IPC_CHANNELS,
  SYSTEM_PROMPT_IPC_CHANNELS
} from "@lume/shared";
import type {
  AttachmentSaveInput,
  AttachmentSaveResult,
  ChatMessage,
  ChatSendInput,
  ChatToolChangedEvent,
  ChatToolInfo,
  ChatToolMeta,
  ChatToolState,
  ChatToolTestResult,
  ConversationMeta,
  FileDialogResult,
  GenerateTitleInput,
  RecentMessagesResult,
  StreamChunkEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamReasoningEvent,
  StreamToolActivityEvent,
  SystemPrompt,
  SystemPromptConfig,
  SystemPromptCreateInput,
  SystemPromptUpdateInput
} from "@lume/shared";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { onSidecarMethodEvent, sidecarCall } from "./core";

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

export async function generateConversationTitle(input: GenerateTitleInput): Promise<string | null> {
  return sidecarCall<string | null>(CHAT_IPC_CHANNELS.GENERATE_TITLE, input);
}

export async function getSystemPromptConfig(): Promise<SystemPromptConfig> {
  return sidecarCall<SystemPromptConfig>(SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG);
}

export async function createSystemPrompt(input: SystemPromptCreateInput): Promise<SystemPrompt> {
  return sidecarCall<SystemPrompt>(SYSTEM_PROMPT_IPC_CHANNELS.CREATE, input);
}

export async function updateSystemPrompt(
  id: string,
  input: SystemPromptUpdateInput
): Promise<SystemPrompt> {
  return sidecarCall<SystemPrompt>(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE, { id, input });
}

export async function deleteSystemPrompt(id: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(SYSTEM_PROMPT_IPC_CHANNELS.DELETE, { id });
}

export async function updateSystemPromptAppendSetting(enabled: boolean): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING, { enabled });
}

export async function setDefaultSystemPrompt(id: string | null): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT, { id });
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

export async function onChatStreamToolActivity(
  handler: (event: StreamToolActivityEvent) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, (params) => {
    handler(params as StreamToolActivityEvent);
  });
}

export async function getChatTools(): Promise<ChatToolInfo[]> {
  return sidecarCall<ChatToolInfo[]>(CHAT_TOOL_IPC_CHANNELS.GET_ALL_TOOLS);
}

export async function getChatToolCredentials(toolId: string): Promise<Record<string, string>> {
  return sidecarCall<Record<string, string>>(CHAT_TOOL_IPC_CHANNELS.GET_TOOL_CREDENTIALS, { toolId });
}

export async function updateChatToolState(toolId: string, state: ChatToolState): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE, { toolId, state });
}

export async function updateChatToolCredentials(
  toolId: string,
  credentials: Record<string, string>
): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_CREDENTIALS, { toolId, credentials });
}

export async function testChatTool(toolId: string): Promise<ChatToolTestResult> {
  return sidecarCall<ChatToolTestResult>(CHAT_TOOL_IPC_CHANNELS.TEST_TOOL, { toolId });
}

export async function createCustomChatTool(meta: ChatToolMeta): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHAT_TOOL_IPC_CHANNELS.CREATE_CUSTOM_TOOL, { meta });
}

export async function deleteCustomChatTool(toolId: string): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(CHAT_TOOL_IPC_CHANNELS.DELETE_CUSTOM_TOOL, { toolId });
}

export async function onChatToolChanged(
  handler: (event: ChatToolChangedEvent) => void
): Promise<UnlistenFn> {
  return onSidecarMethodEvent(CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, (params) => {
    handler(params as ChatToolChangedEvent);
  });
}
