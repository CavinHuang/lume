/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\chat-service.ts
 * Adaptation:
 * - Replaced Electron webContents with callback emitter.
 * - Provider imports switched to local sidecar providers.
 */

import { randomUUID } from "node:crypto";
import type {
  ChatToolActivity,
  ChatMessage,
  ChatSendInput,
  FileAttachment,
  GenerateTitleInput,
  StreamChunkEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamReasoningEvent,
  StreamToolActivityEvent
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
import { ensureDefaultWorkspace } from "./agent-workspace-manager";
import { searchWorkspaceMemory } from "./memory-service";
import { getChatToolCredentials } from "./chat-tool-manager";

type ChatEventEmitter = {
  onChunk: (event: StreamChunkEvent) => void;
  onReasoning: (event: StreamReasoningEvent) => void;
  onComplete: (event: StreamCompleteEvent) => void;
  onError: (event: StreamErrorEvent) => void;
  onToolActivity: (event: StreamToolActivityEvent) => void;
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

const WEB_SEARCH_KEYWORD_PATTERN = /\b(latest|today|current|news|price|weather|score|release|update)\b|最新|今天|现在|新闻|价格|汇率|天气|比分|发布|更新/iu;

function shouldRunWebSearch(userMessage: string): boolean {
  return WEB_SEARCH_KEYWORD_PATTERN.test(userMessage);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeDuckDuckGoRedirectUrl(rawUrl: string): string {
  const normalized = rawUrl.replace(/&amp;/gi, "&");
  const index = normalized.indexOf("uddg=");
  if (index < 0) return normalized;
  const encoded = normalized.slice(index + 5).split("&")[0] ?? "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return normalized;
  }
}

function parseDuckDuckGoResults(
  html: string,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;

  const links: Array<{ title: string; url: string }> = [];
  const snippets: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) && links.length < maxResults + 2) {
    links.push({
      url: decodeDuckDuckGoRedirectUrl(match[1] ?? ""),
      title: stripHtmlTags(match[2] ?? "")
    });
  }

  while ((match = snippetRegex.exec(html)) && snippets.length < maxResults + 2) {
    snippets.push(stripHtmlTags(match[1] ?? ""));
  }

  return links.slice(0, maxResults).map((item, index) => ({
    title: item.title || `Result ${index + 1}`,
    url: item.url,
    snippet: snippets[index] ?? ""
  }));
}

async function searchWebByDuckDuckGo(query: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "Lume-Chat/1.0 (+web_search)"
      }
    });
    if (!response.ok) {
      throw new Error(`web_search 请求失败: ${response.status}`);
    }
    const html = await response.text();
    const results = parseDuckDuckGoResults(html, 5);
    if (results.length === 0) {
      return "未检索到可用搜索结果。";
    }
    return results
      .map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`.trim())
      .join("\n\n");
  } finally {
    clearTimeout(timer);
  }
}

async function searchWebByBrave(query: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "x-subscription-token": apiKey,
        "accept": "application/json",
        "user-agent": "Lume-Chat/1.0 (+web_search)"
      }
    });
    if (!response.ok) {
      throw new Error(`web_search(brave) 请求失败: ${response.status}`);
    }
    const payload = await response.json() as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const items = payload.web?.results?.slice(0, 5) ?? [];
    if (items.length === 0) {
      return "未检索到可用搜索结果。";
    }
    return items
      .map((item, index) => `${index + 1}. ${item.title ?? "Untitled"}\n${item.url ?? ""}\n${item.description ?? ""}`.trim())
      .join("\n\n");
  } finally {
    clearTimeout(timer);
  }
}

async function searchWebByTavily(query: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "Lume-Chat/1.0 (+web_search)"
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 5
      })
    });
    if (!response.ok) {
      throw new Error(`web_search(tavily) 请求失败: ${response.status}`);
    }
    const payload = await response.json() as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const items = payload.results?.slice(0, 5) ?? [];
    if (items.length === 0) {
      return "未检索到可用搜索结果。";
    }
    return items
      .map((item, index) => `${index + 1}. ${item.title ?? "Untitled"}\n${item.url ?? ""}\n${item.content ?? ""}`.trim())
      .join("\n\n");
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query: string): Promise<{ provider: "duckduckgo" | "brave" | "tavily"; result: string }> {
  const credentials = getChatToolCredentials("web_search");
  const braveApiKey = credentials.braveApiKey?.trim();
  const tavilyApiKey = credentials.tavilyApiKey?.trim();

  const attempts: Array<{
    provider: "duckduckgo" | "brave" | "tavily";
    run: () => Promise<string>;
  }> = [];

  // 配置了 API Key 时优先使用对应 provider；未配置时默认 DuckDuckGo。
  if (braveApiKey) {
    attempts.push({
      provider: "brave",
      run: () => searchWebByBrave(query, braveApiKey)
    });
  }
  if (tavilyApiKey) {
    attempts.push({
      provider: "tavily",
      run: () => searchWebByTavily(query, tavilyApiKey)
    });
  }
  attempts.push({
    provider: "duckduckgo",
    run: () => searchWebByDuckDuckGo(query)
  });

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return {
        provider: attempt.provider,
        result: await attempt.run()
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw (lastError ?? new Error("web_search 未命中可用 provider"));
}

async function runEnabledToolsForChat(input: {
  conversationId: string;
  userMessage: string;
  enabledToolIds?: string[];
  emitToolActivity: (activity: ChatToolActivity) => void;
}): Promise<string | undefined> {
  const enabled = new Set((input.enabledToolIds ?? []).filter((item) => typeof item === "string"));
  const contextSections: string[] = [];

  if (enabled.has("memory_search")) {
    const toolCallId = randomUUID();
    input.emitToolActivity({
      type: "start",
      toolName: "memory_search",
      toolCallId
    });
    try {
      const workspace = ensureDefaultWorkspace();
      const results = await searchWorkspaceMemory({
        workspaceSlug: workspace.slug,
        query: input.userMessage,
        maxResults: 5
      });
      const text = results.length === 0
        ? "未检索到相关记忆。"
        : results
          .map((item, index) => `${index + 1}. [${item.path}] ${item.snippet}`.trim())
          .join("\n\n");
      contextSections.push(`memory_search:\n${text}`);
      input.emitToolActivity({
        type: "result",
        toolName: "memory_search",
        toolCallId,
        result: text
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({
        type: "result",
        toolName: "memory_search",
        toolCallId,
        result: message,
        isError: true
      });
    }
  }

  if (enabled.has("web_search") && shouldRunWebSearch(input.userMessage)) {
    const toolCallId = randomUUID();
    input.emitToolActivity({
      type: "start",
      toolName: "web_search",
      toolCallId
    });
    try {
      const { provider, result } = await searchWeb(input.userMessage);
      contextSections.push(`web_search(${provider}):\n${result}`);
      input.emitToolActivity({
        type: "result",
        toolName: "web_search",
        toolCallId,
        result: `[provider=${provider}]\n${result}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({
        type: "result",
        toolName: "web_search",
        toolCallId,
        result: message,
        isError: true
      });
    }
  }

  if (contextSections.length === 0) {
    return undefined;
  }

  return [
    "以下是本轮工具执行结果，可作为回答参考：",
    ...contextSections
  ].join("\n\n");
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
  const emitToolActivity = (activity: ChatToolActivity): void => {
    accumulatedToolActivities.push(activity);
    emit.onToolActivity({ conversationId, activity });
  };

  const toolContextAppendix = await runEnabledToolsForChat({
    conversationId,
    userMessage,
    enabledToolIds,
    emitToolActivity
  });
  const effectiveSystemMessage = [systemMessage, toolContextAppendix].filter(Boolean).join("\n\n") || undefined;

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
      model: modelId,
      toolActivities: accumulatedToolActivities.length > 0 ? accumulatedToolActivities : undefined
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
      systemMessage: effectiveSystemMessage,
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
      reasoning: reasoning || undefined,
      toolActivities: accumulatedToolActivities.length > 0 ? accumulatedToolActivities : undefined
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
          stopped: true,
          toolActivities: accumulatedToolActivities.length > 0 ? accumulatedToolActivities : undefined
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
