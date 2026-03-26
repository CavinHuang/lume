import { randomUUID } from "node:crypto";
import type {
  ChatToolActivity,
  FileAttachment,
  StreamCompleteEvent,
  StreamErrorEvent,
} from "@lume/shared";
import { appendMessage, updateConversationMeta } from "./conversation-manager";

export interface ChatCompletionEmitter {
  onComplete: (event: StreamCompleteEvent) => void;
  onError: (event: StreamErrorEvent) => void;
}

interface PersistAssistantMessageInput {
  conversationId: string;
  userMessage: string;
  userAttachments?: FileAttachment[];
  assistantContent: string;
  assistantModel: string;
  assistantReasoning?: string;
  stopped?: boolean;
  assistantAttachments?: FileAttachment[];
  toolActivities?: ChatToolActivity[];
}

function buildOptionalAttachments(attachments?: FileAttachment[]): FileAttachment[] | undefined {
  return attachments && attachments.length > 0 ? attachments : undefined;
}

function buildOptionalToolActivities(toolActivities?: ChatToolActivity[]): ChatToolActivity[] | undefined {
  return toolActivities && toolActivities.length > 0 ? toolActivities : undefined;
}

export function persistAssistantTurn(input: PersistAssistantMessageInput): string {
  appendMessage(input.conversationId, {
    id: randomUUID(),
    role: "user",
    content: input.userMessage,
    createdAt: Date.now(),
    attachments: buildOptionalAttachments(input.userAttachments),
  });

  const assistantMessageId = randomUUID();
  appendMessage(input.conversationId, {
    id: assistantMessageId,
    role: "assistant",
    content: input.assistantContent,
    createdAt: Date.now(),
    model: input.assistantModel,
    reasoning: input.assistantReasoning || undefined,
    stopped: input.stopped,
    attachments: buildOptionalAttachments(input.assistantAttachments),
    toolActivities: buildOptionalToolActivities(input.toolActivities),
  });
  updateConversationMeta(input.conversationId, {});
  return assistantMessageId;
}

export function completeMockResponse(input: {
  conversationId: string;
  userMessage: string;
  userAttachments?: FileAttachment[];
  assistantContent: string;
  assistantModel: string;
  assistantAttachments?: FileAttachment[];
  toolActivities?: ChatToolActivity[];
  emit: ChatCompletionEmitter;
}): void {
  const assistantMessageId = persistAssistantTurn({
    conversationId: input.conversationId,
    userMessage: input.userMessage,
    userAttachments: input.userAttachments,
    assistantContent: input.assistantContent,
    assistantModel: input.assistantModel,
    assistantAttachments: input.assistantAttachments,
    toolActivities: input.toolActivities,
  });
  input.emit.onComplete({
    conversationId: input.conversationId,
    model: input.assistantModel,
    messageId: assistantMessageId,
  });
}

export function completeAssistantResponse(input: {
  conversationId: string;
  userMessage: string;
  userAttachments?: FileAttachment[];
  assistantContent: string;
  assistantModel: string;
  assistantReasoning?: string;
  assistantAttachments?: FileAttachment[];
  toolActivities?: ChatToolActivity[];
  emit: ChatCompletionEmitter;
}): void {
  const assistantMessageId = persistAssistantTurn({
    conversationId: input.conversationId,
    userMessage: input.userMessage,
    userAttachments: input.userAttachments,
    assistantContent: input.assistantContent,
    assistantModel: input.assistantModel,
    assistantReasoning: input.assistantReasoning,
    assistantAttachments: input.assistantAttachments,
    toolActivities: input.toolActivities,
  });
  input.emit.onComplete({
    conversationId: input.conversationId,
    model: input.assistantModel,
    messageId: assistantMessageId,
  });
}

export function completeAbortedAssistantResponse(input: {
  conversationId: string;
  userMessage: string;
  userAttachments?: FileAttachment[];
  assistantContent: string;
  assistantModel: string;
  assistantReasoning?: string;
  assistantAttachments?: FileAttachment[];
  toolActivities?: ChatToolActivity[];
  emit: ChatCompletionEmitter;
}): void {
  const assistantMessageId = persistAssistantTurn({
    conversationId: input.conversationId,
    userMessage: input.userMessage,
    userAttachments: input.userAttachments,
    assistantContent: input.assistantContent,
    assistantModel: input.assistantModel,
    assistantReasoning: input.assistantReasoning,
    stopped: true,
    assistantAttachments: input.assistantAttachments,
    toolActivities: input.toolActivities,
  });
  input.emit.onComplete({
    conversationId: input.conversationId,
    model: input.assistantModel,
    messageId: assistantMessageId,
  });
}

export function completeEmptyAbort(input: {
  conversationId: string;
  assistantModel: string;
  emit: ChatCompletionEmitter;
}): void {
  input.emit.onComplete({
    conversationId: input.conversationId,
    model: input.assistantModel,
    messageId: "",
  });
}

export function emitChatSendError(input: {
  conversationId: string;
  error: string;
  emit: ChatCompletionEmitter;
}): void {
  input.emit.onError({
    conversationId: input.conversationId,
    error: input.error,
  });
}
