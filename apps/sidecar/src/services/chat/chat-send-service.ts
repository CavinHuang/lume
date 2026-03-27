/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\chat-service.ts
 * Adaptation:
 * - Replaced Electron webContents with callback emitter.
 * - Provider imports switched to local sidecar providers.
 */

import type {
  ChatToolActivity,
  ChatMessage,
  ChatSendInput,
  FileAttachment,
  StreamChunkEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamReasoningEvent,
  StreamToolActivityEvent
} from "@lume/shared";
import { CHAT_IPC_CHANNELS } from "@lume/shared";
import {
  getAdapter,
  streamSSE,
  type ContinuationMessage,
  type ImageAttachmentData,
  type ToolCall,
  type ToolResult
} from "../../providers";
import { isImageAttachment, readAttachmentAsBase64 } from "./attachment-service";
import { decryptApiKey, listChannels } from "../channel/channel-manager";
import { extractTextFromAttachment, isDocumentAttachment } from "./document-parser";
import { getConversationMessages } from "./conversation-manager";
import {
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "../channel/model-selection";
import {
  getEnabledChatToolMetas,
  getEnabledChatToolSystemPromptAppend
} from "./chat-tool-manager";
import {
  completeAbortedAssistantResponse,
  completeAssistantResponse,
  completeEmptyAbort,
  completeMockResponse,
  emitChatSendError
} from "./chat-history-service";
import { getDefaultToolDefinitions } from "./chat-tool-definition-service";
import {
  executeToolCallForChat,
  getLatestAttachmentsByRole,
  runEnabledToolsForChat
} from "./chat-tool-execution-service";

type ChatEventEmitter = {
  onChunk: (event: StreamChunkEvent) => void;
  onReasoning: (event: StreamReasoningEvent) => void;
  onComplete: (event: StreamCompleteEvent) => void;
  onError: (event: StreamErrorEvent) => void;
  onToolActivity: (event: StreamToolActivityEvent) => void;
};

const activeControllers = new Map<string, AbortController>();
const MAX_TOOL_CALLING_ROUNDS = 6;
const TOOL_CALLING_ROUND_LIMIT_MESSAGE = "工具调用轮次达到上限，已停止继续调用。请缩小问题范围后重试。";

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
    thinkingEnabled,
    enabledToolIds
  } = input;

  const accumulatedToolActivities: ChatToolActivity[] = [];
  const accumulatedGeneratedAttachments: FileAttachment[] = [];
  const emitToolActivity = (activity: ChatToolActivity): void => {
    accumulatedToolActivities.push(activity);
    emit.onToolActivity({ conversationId, activity });
  };
  const fullHistory = getConversationMessages(conversationId);
  const previousUserAttachments = getLatestAttachmentsByRole(fullHistory, "user");
  const previousAssistantAttachments = getLatestAttachmentsByRole(fullHistory, "assistant");

  if (process.env.LUME_CHAT_MOCK_SUCCESS === "1") {
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
    return;
  }

  const channels = listChannels();
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) {
    emitChatSendError({ conversationId, error: "渠道不存在", emit });
    return;
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(channelId);
  } catch {
    emitChatSendError({ conversationId, error: "解密 API Key 失败", emit });
    return;
  }

  const selectedModelId = resolveRequestedModelIdForChannel(channel, modelId) ?? modelId;
  const modelSelection = resolveChannelModelSelection({
    channelProvider: channel.provider,
    baseUrl: channel.baseUrl,
    modelId: selectedModelId
  });

  const enabledToolMetas = getEnabledChatToolMetas(enabledToolIds);
  const useModelToolCalling = (
    (
      modelSelection.adapterProvider === "openai"
      || modelSelection.adapterProvider === "anthropic"
      || modelSelection.adapterProvider === "google"
    )
    && enabledToolMetas.length > 0
  );
  const toolExecutionResult = useModelToolCalling
    ? undefined
    : await runEnabledToolsForChat({
      conversationId,
      userMessage,
      messageHistory: fullHistory,
      attachments,
      previousUserAttachments,
      previousAssistantAttachments,
      enabledToolIds,
      emitToolActivity
    });
  if (toolExecutionResult?.generatedAttachments.length) {
    accumulatedGeneratedAttachments.push(...toolExecutionResult.generatedAttachments);
  }
  const toolContextAppendix = toolExecutionResult?.contextAppendix;
  const toolSystemPromptAppend = getEnabledChatToolSystemPromptAppend(enabledToolIds);
  const effectiveSystemMessage = [systemMessage, toolSystemPromptAppend, toolContextAppendix]
    .filter(Boolean)
    .join("\n\n") || undefined;

  const controller = new AbortController();
  // 先中止同一对话的旧请求，防止 AbortController 泄漏
  const existing = activeControllers.get(conversationId);
  if (existing) existing.abort();
  activeControllers.set(conversationId, controller);

  const filteredHistory = filterHistory(fullHistory, contextDividers, contextLength);
  const enrichedHistory = await enrichHistoryWithDocuments(filteredHistory);
  const enrichedUserMessage = await enrichMessageWithDocuments(userMessage, attachments);

  let accumulatedContent = "";
  let accumulatedReasoning = "";
  let finalContent = "";
  let finalReasoning = "";

  try {
    const adapter = getAdapter(modelSelection.adapterProvider);
    const handleStreamEvent = (event: { type: string; delta?: string }): void => {
      if (event.type === "chunk" && typeof event.delta === "string") {
        accumulatedContent += event.delta;
        emit.onChunk({ conversationId, delta: event.delta });
        return;
      }
      if (event.type === "reasoning" && typeof event.delta === "string") {
        accumulatedReasoning += event.delta;
        emit.onReasoning({ conversationId, delta: event.delta });
      }
    };

    if (useModelToolCalling) {
      const toolDefinitions = getDefaultToolDefinitions(enabledToolMetas);
      const enabledMetaMap = new Map(enabledToolMetas.map((meta) => [meta.id, meta] as const));
      const continuationMessages: ContinuationMessage[] = [];
      let hitToolRoundLimit = false;

      for (let round = 0; round < MAX_TOOL_CALLING_ROUNDS; round += 1) {
        const request = adapter.buildStreamRequest({
          baseUrl: channel.baseUrl,
          apiKey,
          modelId: modelSelection.resolvedModelId,
          history: enrichedHistory,
          userMessage: enrichedUserMessage,
          systemMessage: effectiveSystemMessage,
          attachments,
          readImageAttachments: getImageAttachmentData,
          thinkingEnabled,
          tools: toolDefinitions,
          continuationMessages: continuationMessages.length > 0 ? continuationMessages : undefined
        });

        const { toolCalls, stopReason } = await streamSSE({
          request,
          adapter,
          signal: controller.signal,
          onEvent: handleStreamEvent
        });

        if (toolCalls.length === 0 || stopReason !== "tool_use") {
          break;
        }

        const toolResults: ToolResult[] = [];
        for (const toolCall of toolCalls) {
          const result = await executeToolCallForChat({
            conversationId,
            messageHistory: fullHistory,
            toolCall,
            fallbackQuery: userMessage,
            enabledMetaMap,
            currentAttachments: attachments,
            previousUserAttachments,
            previousAssistantAttachments,
            emitToolActivity
          });
          toolResults.push(result);
          if (result.generatedAttachments && result.generatedAttachments.length > 0) {
            accumulatedGeneratedAttachments.push(...result.generatedAttachments);
          }
        }
        continuationMessages.push(
          { role: "assistant", content: "", toolCalls },
          { role: "tool", results: toolResults }
        );
        if (round === MAX_TOOL_CALLING_ROUNDS - 1) {
          hitToolRoundLimit = true;
        }
      }

      finalContent = accumulatedContent || (hitToolRoundLimit ? TOOL_CALLING_ROUND_LIMIT_MESSAGE : "");
      finalReasoning = accumulatedReasoning;
    } else {
      const request = adapter.buildStreamRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId: modelSelection.resolvedModelId,
        history: enrichedHistory,
        userMessage: enrichedUserMessage,
        systemMessage: effectiveSystemMessage,
        attachments,
        readImageAttachments: getImageAttachmentData,
        thinkingEnabled
      });

      const { content, reasoning } = await streamSSE({
        request,
        adapter,
        signal: controller.signal,
        onEvent: handleStreamEvent
      });
      finalContent = content;
      finalReasoning = reasoning;
    }

    // AI 调用成功后再写入用户消息和 AI 回复，保证一致性
    completeAssistantResponse({
      conversationId,
      userMessage,
      userAttachments: attachments,
      assistantContent: finalContent,
      assistantModel: modelSelection.modelRef,
      assistantReasoning: finalReasoning,
      assistantAttachments: accumulatedGeneratedAttachments,
      toolActivities: accumulatedToolActivities,
      emit
    });
  } catch (error) {
    if (controller.signal.aborted) {
      if (accumulatedContent) {
        completeAbortedAssistantResponse({
          conversationId,
          userMessage,
          userAttachments: attachments,
          assistantContent: accumulatedContent,
          assistantModel: modelSelection.modelRef,
          assistantReasoning: accumulatedReasoning,
          assistantAttachments: accumulatedGeneratedAttachments,
          toolActivities: accumulatedToolActivities,
          emit
        });
      } else {
        completeEmptyAbort({
          conversationId,
          assistantModel: modelSelection.modelRef,
          emit
        });
      }
      return;
    }
    const message = error instanceof Error ? error.message : "未知错误";
    emitChatSendError({ conversationId, error: message, emit });
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

export { CHAT_IPC_CHANNELS };
