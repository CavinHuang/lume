import {
  CHAT_IPC_CHANNELS,
  CHAT_TOOL_IPC_CHANNELS,
  SYSTEM_PROMPT_IPC_CHANNELS
} from "@lume/shared";
import type {
  AttachmentSaveInput,
  GenerateTitleInput,
  SystemPromptCreateInput,
  SystemPromptUpdateInput
} from "@lume/shared";
import {
  createConversation,
  deleteConversation,
  deleteMessage,
  getConversationMessages,
  getRecentMessages,
  listConversations,
  truncateMessagesFrom,
  updateContextDividers,
  updateConversationMeta
} from "../services/chat/conversation-manager";
import { generateTitle, sendMessage, stopGeneration } from "../services/chat/chat-service";
import {
  createSystemPrompt,
  deleteSystemPrompt,
  getSystemPromptConfig,
  setDefaultPrompt,
  updateAppendSetting,
  updateSystemPrompt
} from "../services/system-prompt-manager";
import {
  createCustomChatTool,
  deleteCustomChatTool,
  getAllChatToolInfos,
  getChatToolCredentials,
  testChatTool,
  updateChatToolCredentials,
  updateChatToolState
} from "../services/chat/chat-tool-manager";
import {
  deleteAttachment,
  readAttachmentAsBase64,
  saveAttachment
} from "../services/chat/attachment-service";
import { extractTextFromAttachment } from "../services/document-parser";
import {
  chatContextDividersInputSchema,
  chatConversationIdInputSchema,
  chatLocalPathInputSchema,
  chatMessageIdInputSchema,
  chatRecentMessagesInputSchema,
  chatSendInputSchema,
  chatToolCreateCustomInputSchema,
  chatToolCredentialsUpdateInputSchema,
  chatToolIdInputSchema,
  chatToolStateUpdateInputSchema,
  chatTruncateInputSchema,
  chatUpdateModelInputSchema,
  chatUpdateTitleInputSchema,
  systemPromptAppendInputSchema,
  systemPromptCreateInputSchema,
  systemPromptDeleteInputSchema,
  systemPromptSetDefaultInputSchema,
  systemPromptUpdateInputSchema
} from "./schemas";
import type { NotificationWriter, RpcHandler } from "./types";
import { asObject, asString, validateInput } from "./validation";

export function createChatHandlers(writeNotification: NotificationWriter): Record<string, RpcHandler> {
  return {
    [CHAT_IPC_CHANNELS.LIST_CONVERSATIONS]: async () => listConversations(),
    [CHAT_IPC_CHANNELS.CREATE_CONVERSATION]: async (params) => {
      const payload = asObject(params);
      return createConversation(
        asString(payload.title),
        asString(payload.modelId),
        asString(payload.channelId)
      );
    },
    [CHAT_IPC_CHANNELS.GET_MESSAGES]: async (params) => {
      const input = validateInput(chatConversationIdInputSchema, params, CHAT_IPC_CHANNELS.GET_MESSAGES);
      return getConversationMessages(input.conversationId);
    },
    [CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES]: async (params) => {
      const input = validateInput(chatRecentMessagesInputSchema, params, CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES);
      return getRecentMessages(input.conversationId, input.limit);
    },
    [CHAT_IPC_CHANNELS.UPDATE_TITLE]: async (params) => {
      const input = validateInput(chatUpdateTitleInputSchema, params, CHAT_IPC_CHANNELS.UPDATE_TITLE);
      return updateConversationMeta(input.conversationId, { title: input.title });
    },
    [CHAT_IPC_CHANNELS.DELETE_CONVERSATION]: async (params) => {
      const input = validateInput(chatConversationIdInputSchema, params, CHAT_IPC_CHANNELS.DELETE_CONVERSATION);
      deleteConversation(input.conversationId);
      return { ok: true };
    },
    [CHAT_IPC_CHANNELS.UPDATE_MODEL]: async (params) => {
      const input = validateInput(chatUpdateModelInputSchema, params, CHAT_IPC_CHANNELS.UPDATE_MODEL);
      return updateConversationMeta(input.conversationId, {
        modelId: input.modelId,
        channelId: input.channelId
      });
    },
    [CHAT_IPC_CHANNELS.DELETE_MESSAGE]: async (params) => {
      const input = validateInput(chatMessageIdInputSchema, params, CHAT_IPC_CHANNELS.DELETE_MESSAGE);
      return deleteMessage(input.conversationId, input.messageId);
    },
    [CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM]: async (params) => {
      const input = validateInput(chatTruncateInputSchema, params, CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM);
      return truncateMessagesFrom(
        input.conversationId,
        input.messageId,
        input.preserveFirstMessageAttachments === true
      );
    },
    [CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS]: async (params) => {
      const input = validateInput(chatContextDividersInputSchema, params, CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS);
      return updateContextDividers(input.conversationId, input.dividers);
    },
    [CHAT_IPC_CHANNELS.TOGGLE_PIN]: async (params) => {
      const input = validateInput(chatConversationIdInputSchema, params, CHAT_IPC_CHANNELS.TOGGLE_PIN);
      const conversations = listConversations();
      const target = conversations.find((item) => item.id === input.conversationId);
      if (!target) {
        throw new Error("对话不存在");
      }
      return updateConversationMeta(input.conversationId, { pinned: !target.pinned });
    },
    [CHAT_IPC_CHANNELS.GENERATE_TITLE]: async (params) => generateTitle(params as GenerateTitleInput),
    [CHAT_IPC_CHANNELS.SAVE_ATTACHMENT]: async (params) => saveAttachment(params as AttachmentSaveInput),
    [CHAT_IPC_CHANNELS.READ_ATTACHMENT]: async (params) => {
      const input = validateInput(chatLocalPathInputSchema, params, CHAT_IPC_CHANNELS.READ_ATTACHMENT);
      return readAttachmentAsBase64(input.localPath);
    },
    [CHAT_IPC_CHANNELS.DELETE_ATTACHMENT]: async (params) => {
      const input = validateInput(chatLocalPathInputSchema, params, CHAT_IPC_CHANNELS.DELETE_ATTACHMENT);
      deleteAttachment(input.localPath);
      return { ok: true };
    },
    [CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG]: async () => ({ files: [] }),
    [CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT]: async (params) => {
      const input = validateInput(chatLocalPathInputSchema, params, CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT);
      return extractTextFromAttachment(input.localPath);
    },
    [CHAT_IPC_CHANNELS.STOP_GENERATION]: async (params) => {
      const input = validateInput(chatConversationIdInputSchema, params, CHAT_IPC_CHANNELS.STOP_GENERATION);
      stopGeneration(input.conversationId);
      return { ok: true };
    },
    [CHAT_IPC_CHANNELS.SEND_MESSAGE]: async (params) => {
      const input = validateInput(chatSendInputSchema, params, CHAT_IPC_CHANNELS.SEND_MESSAGE);
      void sendMessage(input, {
        onChunk: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_CHUNK, event),
        onReasoning: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_REASONING, event),
        onComplete: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_COMPLETE, event),
        onError: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_ERROR, event),
        onToolActivity: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, event)
      }).catch((error) => {
        writeNotification(CHAT_IPC_CHANNELS.STREAM_ERROR, {
          conversationId: input.conversationId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return { ok: true };
    },
    [CHAT_TOOL_IPC_CHANNELS.GET_ALL_TOOLS]: async () => getAllChatToolInfos(),
    [CHAT_TOOL_IPC_CHANNELS.GET_TOOL_CREDENTIALS]: async (params) => {
      const input = validateInput(chatToolIdInputSchema, params, CHAT_TOOL_IPC_CHANNELS.GET_TOOL_CREDENTIALS);
      return getChatToolCredentials(input.toolId);
    },
    [CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE]: async (params) => {
      const input = validateInput(chatToolStateUpdateInputSchema, params, CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE);
      updateChatToolState(input.toolId, input.state);
      writeNotification(CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, {
        toolId: input.toolId,
        changeType: "state"
      });
      return { ok: true };
    },
    [CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_CREDENTIALS]: async (params) => {
      const input = validateInput(
        chatToolCredentialsUpdateInputSchema,
        params,
        CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_CREDENTIALS
      );
      updateChatToolCredentials(input.toolId, input.credentials);
      writeNotification(CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, {
        toolId: input.toolId,
        changeType: "credentials"
      });
      return { ok: true };
    },
    [CHAT_TOOL_IPC_CHANNELS.TEST_TOOL]: async (params) => {
      const input = validateInput(chatToolIdInputSchema, params, CHAT_TOOL_IPC_CHANNELS.TEST_TOOL);
      return testChatTool(input.toolId);
    },
    [CHAT_TOOL_IPC_CHANNELS.CREATE_CUSTOM_TOOL]: async (params) => {
      const input = validateInput(
        chatToolCreateCustomInputSchema,
        params,
        CHAT_TOOL_IPC_CHANNELS.CREATE_CUSTOM_TOOL
      );
      createCustomChatTool(input.meta);
      writeNotification(CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, {
        toolId: input.meta.id,
        changeType: "create"
      });
      return { ok: true };
    },
    [CHAT_TOOL_IPC_CHANNELS.DELETE_CUSTOM_TOOL]: async (params) => {
      const input = validateInput(chatToolIdInputSchema, params, CHAT_TOOL_IPC_CHANNELS.DELETE_CUSTOM_TOOL);
      deleteCustomChatTool(input.toolId);
      writeNotification(CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, {
        toolId: input.toolId,
        changeType: "delete"
      });
      return { ok: true };
    },
    [SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG]: async () => getSystemPromptConfig(),
    [SYSTEM_PROMPT_IPC_CHANNELS.CREATE]: async (params) => {
      const input = validateInput(systemPromptCreateInputSchema, params, SYSTEM_PROMPT_IPC_CHANNELS.CREATE);
      return createSystemPrompt(input as SystemPromptCreateInput);
    },
    [SYSTEM_PROMPT_IPC_CHANNELS.UPDATE]: async (params) => {
      const input = validateInput(systemPromptUpdateInputSchema, params, SYSTEM_PROMPT_IPC_CHANNELS.UPDATE);
      return updateSystemPrompt(input.id, input.input as SystemPromptUpdateInput);
    },
    [SYSTEM_PROMPT_IPC_CHANNELS.DELETE]: async (params) => {
      const input = validateInput(systemPromptDeleteInputSchema, params, SYSTEM_PROMPT_IPC_CHANNELS.DELETE);
      deleteSystemPrompt(input.id);
      return { ok: true };
    },
    [SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING]: async (params) => {
      const input = validateInput(
        systemPromptAppendInputSchema,
        params,
        SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING
      );
      updateAppendSetting(input.enabled);
      return { ok: true };
    },
    [SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT]: async (params) => {
      const input = validateInput(
        systemPromptSetDefaultInputSchema,
        params,
        SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT
      );
      setDefaultPrompt(input.id);
      return { ok: true };
    }
  };
}
