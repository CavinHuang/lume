import type {
  ChatToolActivity,
  FileAttachment,
  StreamChunkEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamToolActivityEvent
} from "@lume/shared";
import { completeMockResponse } from "./chat-history-service";
import {
  getLatestAttachmentsByRole,
  runEnabledToolsForChat
} from "./chat-tool-execution-service";
import { getConversationMessages } from "./conversation-manager";

type MockChatSendEmitter = {
  onChunk: (event: StreamChunkEvent) => void;
  onComplete: (event: StreamCompleteEvent) => void;
  onError: (event: StreamErrorEvent) => void;
  onToolActivity: (event: StreamToolActivityEvent) => void;
};

/**
 * Returns a mock send handler when `LUME_CHAT_MOCK_SUCCESS` is enabled, otherwise null.
 */
export function resolveMockSend(): ((params: {
  conversationId: string;
  userMessage: string;
  modelId: string;
  attachments?: FileAttachment[];
  enabledToolIds?: string[];
  emit: MockChatSendEmitter;
}) => Promise<void>) | null {
  if (process.env.LUME_CHAT_MOCK_SUCCESS !== "1") {
    return null;
  }
  return runMockChatSend;
}

async function runMockChatSend(params: {
  conversationId: string;
  userMessage: string;
  modelId: string;
  attachments?: FileAttachment[];
  enabledToolIds?: string[];
  emit: MockChatSendEmitter;
}): Promise<void> {
  const { conversationId, userMessage, modelId, attachments, enabledToolIds, emit } = params;
  const accumulatedToolActivities: ChatToolActivity[] = [];
  const accumulatedGeneratedAttachments: FileAttachment[] = [];

  const emitToolActivity = (activity: ChatToolActivity) => {
    accumulatedToolActivities.push(activity);
    emit.onToolActivity({ conversationId, activity });
  };

  const fullHistory = getConversationMessages(conversationId);
  const previousUserAttachments = getLatestAttachmentsByRole(fullHistory, "user");
  const previousAssistantAttachments = getLatestAttachmentsByRole(fullHistory, "assistant");

  const toolResult = await runEnabledToolsForChat({
    conversationId,
    userMessage,
    messageHistory: fullHistory,
    attachments,
    previousUserAttachments,
    previousAssistantAttachments,
    enabledToolIds,
    emitToolActivity
  });
  if (toolResult.generatedAttachments.length > 0) {
    accumulatedGeneratedAttachments.push(...toolResult.generatedAttachments);
  }

  const mockDelta = (process.env.LUME_CHAT_MOCK_TEXT || "chat-mock-success").trim();
  emit.onChunk({ conversationId, delta: mockDelta });
  completeMockResponse({
    conversationId,
    userMessage,
    userAttachments: attachments,
    assistantContent: mockDelta,
    assistantModel: modelId,
    assistantAttachments: accumulatedGeneratedAttachments,
    toolActivities: accumulatedToolActivities,
    emit
  });
}
