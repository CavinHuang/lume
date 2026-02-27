/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\chat-service.ts
 * Adaptation:
 * - Replaced Electron webContents with callback emitter.
 * - Provider imports switched to local sidecar providers.
 */

import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatSendInput,
  FileAttachment,
  GenerateTitleInput,
  StreamChunkEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamReasoningEvent
} from "@lume/shared";
import { CHAT_IPC_CHANNELS } from "@lume/shared";
import { fetchTitle, getAdapter, streamSSE, type ImageAttachmentData } from "../providers";
import { isImageAttachment, readAttachmentAsBase64 } from "./attachment-service";
import { decryptApiKey, listChannels } from "./channel-manager";
import { extractTextFromAttachment, isDocumentAttachment } from "./document-parser";
import { appendMessage, getConversationMessages, updateConversationMeta } from "./conversation-manager";
import {
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "./model-selection";

type ChatEventEmitter = {
  onChunk: (event: StreamChunkEvent) => void;
  onReasoning: (event: StreamReasoningEvent) => void;
  onComplete: (event: StreamCompleteEvent) => void;
  onError: (event: StreamErrorEvent) => void;
};

const activeControllers = new Map<string, AbortController>();

function getImageAttachmentData(attachments?: FileAttachment[]): ImageAttachmentData[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments
    .filter((att) => isImageAttachment(att.mediaType))
    .map((att) => ({ mediaType: att.mediaType, data: readAttachmentAsBase64(att.localPath) }));
}

async function enrichMessageWithDocuments(messageText: string, attachments?: FileAttachment[]): Promise<string> {
  if (!attachments || attachments.length === 0) return messageText;
  const docAttachments = attachments.filter((att) => isDocumentAttachment(att.mediaType));
  if (docAttachments.length === 0) return messageText;
  const parts: string[] = [messageText];
  for (const att of docAttachments) {
    const text = await extractTextFromAttachment(att.localPath);
    parts.push(`\n<file name="${att.filename}">\n${text}\n</file>`);
  }
  return parts.join("");
}

async function enrichHistoryWithDocuments(history: ChatMessage[]): Promise<ChatMessage[]> {
  const enriched: ChatMessage[] = [];
  for (const msg of history) {
    if (msg.role === "user" && msg.attachments?.length) {
      const hasDocuments = msg.attachments.some((att) => isDocumentAttachment(att.mediaType));
      if (hasDocuments) {
        enriched.push({
          ...msg,
          content: await enrichMessageWithDocuments(msg.content, msg.attachments)
        });
        continue;
      }
    }
    enriched.push(msg);
  }
  return enriched;
}

function filterHistory(
  messageHistory: ChatMessage[],
  contextDividers?: string[],
  contextLength?: number | "infinite"
): ChatMessage[] {
  let filtered = [...messageHistory];
  if (contextDividers && contextDividers.length > 0) {
    const lastDividerId = contextDividers[contextDividers.length - 1];
    const dividerIndex = filtered.findIndex((msg) => msg.id === lastDividerId);
    if (dividerIndex >= 0) filtered = filtered.slice(dividerIndex + 1);
  }
  if (typeof contextLength === "number" && contextLength >= 0) {
    if (contextLength === 0) return [];
    const collected: ChatMessage[] = [];
    let roundCount = 0;
    for (let i = filtered.length - 1; i >= 0; i -= 1) {
      const msg = filtered[i] as ChatMessage;
      collected.unshift(msg);
      if (msg.role === "user") {
        roundCount += 1;
        if (roundCount >= contextLength) break;
      }
    }
    return collected;
  }
  return filtered;
}

export async function sendMessage(input: ChatSendInput, emit: ChatEventEmitter): Promise<void> {
  const {
    conversationId,
    userMessage,
    channelId,
    modelId,
    systemMessage,
    contextLength,
    contextDividers,
    attachments,
    thinkingEnabled
  } = input;

  if (process.env.LUME_CHAT_MOCK_SUCCESS === "1") {
    const mockDelta = (process.env.LUME_CHAT_MOCK_TEXT || "chat-mock-success").trim();
    appendMessage(conversationId, {
      id: randomUUID(),
      role: "user",
      content: userMessage,
      createdAt: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined
    });
    emit.onChunk({ conversationId, delta: mockDelta });
    const assistantMsgId = randomUUID();
    appendMessage(conversationId, {
      id: assistantMsgId,
      role: "assistant",
      content: mockDelta,
      createdAt: Date.now(),
      model: modelId
    });
    updateConversationMeta(conversationId, {});
    emit.onComplete({ conversationId, model: modelId, messageId: assistantMsgId });
    return;
  }

  const channels = listChannels();
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) {
    emit.onError({ conversationId, error: "渠道不存在" });
    return;
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(channelId);
  } catch {
    emit.onError({ conversationId, error: "解密 API Key 失败" });
    return;
  }

  const controller = new AbortController();
  // 先中止同一对话的旧请求，防止 AbortController 泄漏
  const existing = activeControllers.get(conversationId);
  if (existing) existing.abort();
  activeControllers.set(conversationId, controller);

  const fullHistory = getConversationMessages(conversationId);
  const filteredHistory = filterHistory(fullHistory, contextDividers, contextLength);
  const enrichedHistory = await enrichHistoryWithDocuments(filteredHistory);
  const enrichedUserMessage = await enrichMessageWithDocuments(userMessage, attachments);

  let accumulatedContent = "";
  let accumulatedReasoning = "";
  const selectedModelId = resolveRequestedModelIdForChannel(channel, modelId) ?? modelId;
  const modelSelection = resolveChannelModelSelection({
    channelProvider: channel.provider,
    baseUrl: channel.baseUrl,
    modelId: selectedModelId
  });

  try {
    const adapter = getAdapter(modelSelection.adapterProvider);
    const request = adapter.buildStreamRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId: modelSelection.resolvedModelId,
      history: enrichedHistory,
      userMessage: enrichedUserMessage,
      systemMessage,
      attachments,
      readImageAttachments: getImageAttachmentData,
      thinkingEnabled
    });

    const { content, reasoning } = await streamSSE({
      request,
      adapter,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "chunk") {
          accumulatedContent += event.delta;
          emit.onChunk({ conversationId, delta: event.delta });
          return;
        }
        if (event.type === "reasoning") {
          accumulatedReasoning += event.delta;
          emit.onReasoning({ conversationId, delta: event.delta });
        }
      }
    });

    // AI 调用成功后再写入用户消息和 AI 回复，保证一致性
    appendMessage(conversationId, {
      id: randomUUID(),
      role: "user",
      content: userMessage,
      createdAt: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined
    });
    const assistantMsgId = randomUUID();
    appendMessage(conversationId, {
      id: assistantMsgId,
      role: "assistant",
      content,
      createdAt: Date.now(),
      model: modelSelection.modelRef,
      reasoning: reasoning || undefined
    });
    updateConversationMeta(conversationId, {});
    emit.onComplete({ conversationId, model: modelSelection.modelRef, messageId: assistantMsgId });
  } catch (error) {
    if (controller.signal.aborted) {
      if (accumulatedContent) {
        // 中止时已有部分内容，写入用户消息和部分 AI 回复
        appendMessage(conversationId, {
          id: randomUUID(),
          role: "user",
          content: userMessage,
          createdAt: Date.now(),
          attachments: attachments && attachments.length > 0 ? attachments : undefined
        });
        const assistantMsgId = randomUUID();
        appendMessage(conversationId, {
          id: assistantMsgId,
          role: "assistant",
          content: accumulatedContent,
          createdAt: Date.now(),
          model: modelSelection.modelRef,
          reasoning: accumulatedReasoning || undefined,
          stopped: true
        });
        updateConversationMeta(conversationId, {});
        emit.onComplete({ conversationId, model: modelSelection.modelRef, messageId: assistantMsgId });
      } else {
        emit.onComplete({ conversationId, model: modelSelection.modelRef, messageId: "" });
      }
      return;
    }
    const message = error instanceof Error ? error.message : "未知错误";
    emit.onError({ conversationId, error: message });
  } finally {
    activeControllers.delete(conversationId);
  }
}

export function stopGeneration(conversationId: string): void {
  const controller = activeControllers.get(conversationId);
  if (!controller) return;
  controller.abort();
  activeControllers.delete(conversationId);
}

export function stopAllGenerations(): void {
  for (const [conversationId, controller] of activeControllers) {
    controller.abort();
    activeControllers.delete(conversationId);
  }
}

const TITLE_PROMPT =
  "根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：";
const MAX_TITLE_LENGTH = 20;

export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  const { userMessage, channelId, modelId } = input;
  const channel = listChannels().find((c) => c.id === channelId);
  if (!channel) return null;
  let apiKey: string;
  try {
    apiKey = decryptApiKey(channelId);
  } catch {
    return null;
  }
  try {
    const selectedModelId = resolveRequestedModelIdForChannel(channel, modelId) ?? modelId;
    const modelSelection = resolveChannelModelSelection({
      channelProvider: channel.provider,
      baseUrl: channel.baseUrl,
      modelId: selectedModelId
    });
    const adapter = getAdapter(modelSelection.adapterProvider);
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId: modelSelection.resolvedModelId,
      prompt: TITLE_PROMPT + userMessage
    });
    const title = await fetchTitle(request, adapter);
    if (!title) return null;
    const cleaned = title.trim().replace(/^["'""'']+|["'""'']+$/g, "").trim();
    return cleaned.slice(0, MAX_TITLE_LENGTH) || null;
  } catch {
    return null;
  }
}

export { CHAT_IPC_CHANNELS };
