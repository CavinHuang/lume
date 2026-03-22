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
  ChatToolMeta,
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
import {
  fetchTitle,
  getAdapter,
  streamSSE,
  type ContinuationMessage,
  type ImageAttachmentData,
  type ToolCall,
  type ToolDefinition,
  type ToolResult
} from "../providers";
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
import {
  getAllChatToolInfos,
  getChatToolCredentials,
  getEnabledChatToolMetas,
  getEnabledChatToolSystemPromptAppend
} from "./chat-tool-manager";
import { executeHttpChatTool } from "./chat-tool-http-executor";
import { generateNanoBananaImage } from "./nano-banana-service";

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

const WEB_SEARCH_KEYWORD_PATTERN = /\b(latest|today|current|news|price|weather|score|release|update)\b|最新|今天|现在|新闻|价格|汇率|天气|比分|发布|更新/iu;
const AGENT_MODE_RECOMMEND_KEYWORD_PATTERN =
  /调研|研究|报告|分析|开发|代码|实现|重构|调试|测试|项目|文件|脚本|命令|自动化|多步骤|搭建|部署|数据库|api|workflow|pipeline|计划|执行|refactor|debug|test|build|research/iu;
const NANO_BANANA_KEYWORD_PATTERN =
  /图片|图像|配图|海报|插画|封面|壁纸|logo|生图|绘图|画一张|生成图|这张图|这幅图|改图|修图|image|poster|illustration|cover|draw|render/iu;
const NANO_BANANA_EDIT_KEYWORD_PATTERN =
  /修改|编辑|重绘|重做|优化|继续|基于|参考|换|改成|replace|edit|modify|adjust|reference/iu;
const NANO_BANANA_CONTINUATION_KEYWORD_PATTERN =
  /继续|延续|保持|同风格|一样|再来|沿用|继续这张|continue|keep style|same style|another version|iterate/iu;
const NANO_BANANA_REPLACE_SUBJECT_KEYWORD_PATTERN =
  /替换主体|换主体|换成|替换成|replace subject|swap subject|change subject/iu;
const NANO_BANANA_ENABLE_TEXT_OVERLAY_PATTERN =
  /加(上)?(标题)?文字|添加(标题)?文字|带文字|加(上)?标题|标题文案|slogan|caption|add text|with text/iu;
const NANO_BANANA_ENABLE_PEOPLE_PATTERN =
  /加入(一个)?人物|加(入)?一个人|有人物|带人物|with (a )?(person|people)|include (a )?(person|people)/iu;
const NANO_BANANA_ENABLE_WATERMARK_PATTERN =
  /加(上)?水印|带水印|with watermark|add watermark/iu;

type NanoBananaConstraintGroup = "watermark" | "textOverlay" | "people" | "subjectIdentity";
interface NanoBananaHintRule {
  pattern: RegExp;
  key: string;
  hint: string;
  group?: NanoBananaConstraintGroup | "renderingStyle";
  polarity?: "allow" | "forbid";
}
interface NanoBananaConstraintPreference {
  watermark?: "allow" | "forbid";
  textOverlay?: "allow" | "forbid";
  people?: "allow" | "forbid";
  subjectIdentity?: "allow" | "forbid";
}
interface NanoBananaIntentMemory {
  styleEntries: NanoBananaHintRule[];
  constraintEntries: NanoBananaHintRule[];
  lastImagePrompt?: string;
}

const NANO_BANANA_STYLE_HINT_RULES: NanoBananaHintRule[] = [
  { pattern: /写实|realistic|photoreal/i, key: "style-photoreal", hint: "photorealistic, highly detailed", group: "renderingStyle" },
  { pattern: /插画|illustration|插图/i, key: "style-illustration", hint: "digital illustration style", group: "renderingStyle" },
  { pattern: /水彩|watercolor/i, key: "style-watercolor", hint: "watercolor texture, soft edges", group: "renderingStyle" },
  { pattern: /动漫|anime|二次元/i, key: "style-anime", hint: "anime style, vivid linework", group: "renderingStyle" },
  { pattern: /赛博朋克|cyberpunk/i, key: "style-cyberpunk", hint: "cyberpunk style, neon lighting" },
  { pattern: /电影|cinematic/i, key: "style-cinematic", hint: "cinematic composition, dramatic lighting" },
  { pattern: /极简|minimal/i, key: "style-minimal", hint: "minimal composition, clean background" }
];
const NANO_BANANA_CONSTRAINT_HINT_RULES: NanoBananaHintRule[] = [
  { pattern: /无水印|不要水印|no watermark/i, key: "constraint-no-watermark", hint: "no watermark", group: "watermark", polarity: "forbid" },
  { pattern: /无文字|不要文字|不要字|no text/i, key: "constraint-no-text-overlay", hint: "no text overlay", group: "textOverlay", polarity: "forbid" },
  { pattern: /无人物|不要人物|no people/i, key: "constraint-no-people", hint: "no people", group: "people", polarity: "forbid" },
  { pattern: /高细节|高质量|高清|high detail|high quality/i, key: "constraint-high-quality", hint: "sharp details, high quality render" }
];
const NANO_BANANA_PRESERVE_SUBJECT_HINT: NanoBananaHintRule = {
  pattern: /(?:)/,
  key: "constraint-preserve-subject-identity",
  hint: "preserve subject identity unless user requests replacement",
  group: "subjectIdentity",
  polarity: "forbid"
};

function shouldRunWebSearch(userMessage: string): boolean {
  return WEB_SEARCH_KEYWORD_PATTERN.test(userMessage);
}

function shouldSuggestAgentMode(userMessage: string): boolean {
  const normalized = userMessage.trim();
  if (!normalized) return false;
  if (AGENT_MODE_RECOMMEND_KEYWORD_PATTERN.test(normalized)) return true;
  return normalized.length >= 80 && /\s|，|。|,|\./.test(normalized);
}

function shouldRunNanoBanana(userMessage: string, attachments?: FileAttachment[]): boolean {
  if (attachments?.some((item) => isImageAttachment(item.mediaType))) {
    return true;
  }
  return NANO_BANANA_KEYWORD_PATTERN.test(userMessage.trim());
}

function hasImageAttachments(attachments?: FileAttachment[]): boolean {
  return attachments?.some((item) => isImageAttachment(item.mediaType)) ?? false;
}

function shouldUseReferenceImagesForNanoBanana(input: {
  userMessage: string;
  currentAttachments?: FileAttachment[];
  previousUserAttachments?: FileAttachment[];
  previousAssistantAttachments?: FileAttachment[];
}): boolean {
  if (hasImageAttachments(input.currentAttachments)) {
    return true;
  }
  const hasPreviousImage = hasImageAttachments(input.previousUserAttachments) || hasImageAttachments(input.previousAssistantAttachments);
  if (!hasPreviousImage) return false;
  return NANO_BANANA_EDIT_KEYWORD_PATTERN.test(input.userMessage);
}

function inferNanoBananaAspectRatio(userMessage: string): string | undefined {
  const text = userMessage.toLowerCase();
  if (text.includes("16:9") || text.includes("横版")) return "16:9";
  if (text.includes("9:16") || text.includes("竖版")) return "9:16";
  if (text.includes("4:3")) return "4:3";
  if (text.includes("3:4")) return "3:4";
  if (text.includes("1:1") || text.includes("方图") || text.includes("正方形")) return "1:1";
  return undefined;
}

function inferNanoBananaImageSize(userMessage: string): string | undefined {
  const text = userMessage.toLowerCase();
  if (text.includes("4k") || text.includes("4096")) return "4K";
  if (text.includes("2k") || text.includes("2048")) return "2K";
  if (text.includes("1k") || text.includes("1024")) return "1K";
  return undefined;
}

function collectPromptHintEntries(
  userMessage: string,
  rules: NanoBananaHintRule[]
): NanoBananaHintRule[] {
  const hints: NanoBananaHintRule[] = [];
  const seenKeys = new Set<string>();
  for (const rule of rules) {
    if (rule.pattern.test(userMessage)) {
      if (seenKeys.has(rule.key)) continue;
      seenKeys.add(rule.key);
      hints.push(rule);
    }
  }
  return hints;
}

function mergePromptHintEntries(
  currentEntries: NanoBananaHintRule[],
  rememberedEntries: NanoBananaHintRule[]
): NanoBananaHintRule[] {
  const merged: NanoBananaHintRule[] = [...currentEntries];
  const currentGroups = new Set(
    currentEntries
      .map((entry) => entry.group)
      .filter((group): group is Exclude<NanoBananaHintRule["group"], undefined> => typeof group === "string")
  );
  for (const remembered of rememberedEntries) {
    if (merged.some((entry) => entry.key === remembered.key)) continue;
    if (remembered.group && currentGroups.has(remembered.group)) continue;
    merged.push(remembered);
  }
  return merged;
}

function resolveConstraintPreference(
  userMessage: string,
  currentConstraintEntries: NanoBananaHintRule[]
): NanoBananaConstraintPreference {
  const preference: NanoBananaConstraintPreference = {};
  for (const entry of currentConstraintEntries) {
    if (!entry.group || !entry.polarity) continue;
    if (entry.group === "watermark" || entry.group === "textOverlay" || entry.group === "people" || entry.group === "subjectIdentity") {
      preference[entry.group] = entry.polarity;
    }
  }

  if (!preference.textOverlay && NANO_BANANA_ENABLE_TEXT_OVERLAY_PATTERN.test(userMessage)) {
    preference.textOverlay = "allow";
  }
  if (!preference.people && NANO_BANANA_ENABLE_PEOPLE_PATTERN.test(userMessage)) {
    preference.people = "allow";
  }
  if (!preference.watermark && NANO_BANANA_ENABLE_WATERMARK_PATTERN.test(userMessage)) {
    preference.watermark = "allow";
  }
  if (NANO_BANANA_REPLACE_SUBJECT_KEYWORD_PATTERN.test(userMessage)) {
    preference.subjectIdentity = "allow";
  }

  return preference;
}

function pruneConstraintConflicts(
  entries: NanoBananaHintRule[],
  preference: NanoBananaConstraintPreference
): NanoBananaHintRule[] {
  const filtered = entries.filter((entry) => {
    if (!entry.group || !entry.polarity) return true;
    if (entry.group === "renderingStyle") return true;
    const pref = preference[entry.group];
    if (!pref) return true;
    return pref === entry.polarity;
  });

  const output: NanoBananaHintRule[] = [];
  const seenKeys = new Set<string>();
  const seenGroups = new Set<string>();
  for (const entry of filtered) {
    if (seenKeys.has(entry.key)) continue;
    if (entry.group && entry.polarity) {
      if (seenGroups.has(entry.group)) continue;
      seenGroups.add(entry.group);
    }
    output.push(entry);
    seenKeys.add(entry.key);
  }
  return output;
}

function collectNanoBananaIntentMemory(messageHistory: ChatMessage[]): NanoBananaIntentMemory {
  for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
    const item = messageHistory[index];
    if (!item || item.role !== "user") continue;
    const text = item.content.trim();
    if (!text) continue;
    const styleEntries = collectPromptHintEntries(text, NANO_BANANA_STYLE_HINT_RULES);
    const constraintEntries = collectPromptHintEntries(text, NANO_BANANA_CONSTRAINT_HINT_RULES);
    const imageIntent = shouldRunNanoBanana(text, item.attachments);
    if (!imageIntent && styleEntries.length === 0 && constraintEntries.length === 0) continue;
    return {
      styleEntries,
      constraintEntries,
      lastImagePrompt: text
    };
  }
  return {
    styleEntries: [],
    constraintEntries: [],
    lastImagePrompt: undefined
  };
}

function summarizePromptForIntentMemory(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 120)}...`;
}

function buildNanoBananaEnhancedPrompt(
  userMessage: string,
  options?: { messageHistory?: ChatMessage[]; useReferenceImages?: boolean }
): string {
  const base = userMessage.trim();
  if (!base) return base;

  const shouldReuseIntent = (
    NANO_BANANA_CONTINUATION_KEYWORD_PATTERN.test(base)
    || options?.useReferenceImages === true
  );
  const intentMemory = shouldReuseIntent
    ? collectNanoBananaIntentMemory(options?.messageHistory ?? [])
    : { styleEntries: [], constraintEntries: [], lastImagePrompt: undefined };

  const styleEntries = collectPromptHintEntries(base, NANO_BANANA_STYLE_HINT_RULES);
  const constraintEntries = collectPromptHintEntries(base, NANO_BANANA_CONSTRAINT_HINT_RULES);
  const constraintPreference = resolveConstraintPreference(base, constraintEntries);
  if (
    NANO_BANANA_EDIT_KEYWORD_PATTERN.test(base)
    && constraintPreference.subjectIdentity !== "allow"
  ) {
    constraintEntries.push(NANO_BANANA_PRESERVE_SUBJECT_HINT);
  }
  const mergedStyleEntries = mergePromptHintEntries(styleEntries, intentMemory.styleEntries);
  const mergedConstraintEntries = pruneConstraintConflicts(
    mergePromptHintEntries(constraintEntries, intentMemory.constraintEntries),
    constraintPreference
  );

  const styleHints = mergedStyleEntries.map((entry) => entry.hint);
  const normalizedConstraintHints = mergedConstraintEntries.map((entry) => entry.hint);

  const hasAsciiWords = /[a-zA-Z]{3,}/.test(base);
  if (styleHints.length === 0 && !hasAsciiWords && /[\u4e00-\u9fff]/.test(base)) {
    styleHints.push("high quality composition, balanced lighting");
  }
  if (styleHints.length === 0 && normalizedConstraintHints.length === 0) {
    return base;
  }
  const sections = [base];
  if (styleHints.length > 0) {
    sections.push(`Style hints: ${styleHints.join("; ")}.`);
  }
  if (normalizedConstraintHints.length > 0) {
    sections.push(`Constraints: ${normalizedConstraintHints.join("; ")}.`);
  }
  if (shouldReuseIntent && intentMemory.lastImagePrompt && intentMemory.lastImagePrompt !== base) {
    sections.push(
      `Intent memory: continue previous request context (${summarizePromptForIntentMemory(intentMemory.lastImagePrompt)}), unless current instructions override it.`
    );
  }
  return sections.join("\n\n");
}

function getLatestAttachmentsByRole(
  history: ChatMessage[],
  role: "user" | "assistant"
): FileAttachment[] | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!item) continue;
    if (item.role !== role) continue;
    if (item.attachments && item.attachments.length > 0) {
      return item.attachments;
    }
  }
  return undefined;
}

function buildAgentModeRecommendation(userMessage: string): { reason: string; suggestedPrompt: string } {
  const normalized = userMessage.trim();
  return {
    reason: "该任务可能涉及多步骤执行、文件与命令操作，Agent 模式可持续执行并回写过程结果，适合复杂任务闭环。",
    suggestedPrompt: normalized.length > 0 ? normalized : "请基于当前需求继续执行"
  };
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

async function runCustomHttpTool(meta: ChatToolMeta, userMessage: string): Promise<string> {
  return executeHttpChatTool(meta, {
    userMessage,
    credentials: getChatToolCredentials(meta.id)
  });
}

function getStringArgument(argumentsObj: Record<string, unknown>, key: string): string | undefined {
  const value = argumentsObj[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getBooleanArgument(argumentsObj: Record<string, unknown>, key: string): boolean | undefined {
  const value = argumentsObj[key];
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function getDefaultToolDefinitions(enabledMetas: ChatToolMeta[]): ToolDefinition[] {
  return enabledMetas.map((meta) => {
    if (meta.id === "memory_search") {
      const definition: ToolDefinition = {
        name: meta.id,
        description: meta.description,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "要检索的关键词或问题"
            }
          },
          required: ["query"]
        }
      };
      return definition;
    }

    if (meta.id === "web_search") {
      const definition: ToolDefinition = {
        name: meta.id,
        description: meta.description,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "要联网搜索的查询词"
            }
          },
          required: ["query"]
        }
      };
      return definition;
    }

    if (meta.id === "suggest_agent_mode") {
      const definition: ToolDefinition = {
        name: meta.id,
        description: meta.description,
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "推荐切换 Agent 模式的理由"
            },
            suggestedPrompt: {
              type: "string",
              description: "建议用户在 Agent 模式使用的初始提示词"
            }
          },
          required: ["reason", "suggestedPrompt"]
        }
      };
      return definition;
    }

    if (meta.id === "nano_banana") {
      const definition: ToolDefinition = {
        name: meta.id,
        description: meta.description,
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "图片生成/编辑描述，英文描述通常效果更好"
            },
            aspectRatio: {
              type: "string",
              description: "图片宽高比",
              enum: ["1:1", "16:9", "4:3", "9:16", "3:4"]
            },
            imageSize: {
              type: "string",
              description: "图片分辨率",
              enum: ["auto", "1K", "2K", "4K"]
            },
            useReferenceImages: {
              type: "boolean",
              description: "是否使用当前或历史图片附件作为参考图"
            }
          },
          required: ["prompt"]
        }
      };
      return definition;
    }

    const props = Object.fromEntries(
      (meta.params ?? []).map((param) => [
        param.name,
        {
          type: param.type,
          description: param.description,
          ...(param.enum && param.enum.length > 0 ? { enum: param.enum } : {})
        }
      ])
    );
    const properties = Object.keys(props).length > 0
      ? props
      : {
        query: {
          type: "string",
          description: "输入查询内容"
        }
      };
    const required = (meta.params ?? [])
      .filter((param) => param.required)
      .map((param) => param.name);

    const definition: ToolDefinition = {
      name: meta.id,
      description: meta.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {})
      }
    };
    return definition;
  });
}

async function executeToolCallForChat(input: {
  conversationId: string;
  messageHistory: ChatMessage[];
  toolCall: ToolCall;
  fallbackQuery: string;
  enabledMetaMap: Map<string, ChatToolMeta>;
  currentAttachments?: FileAttachment[];
  previousUserAttachments?: FileAttachment[];
  previousAssistantAttachments?: FileAttachment[];
  emitToolActivity: (activity: ChatToolActivity) => void;
}): Promise<ToolResult> {
  const { toolCall, fallbackQuery, enabledMetaMap } = input;
  const meta = enabledMetaMap.get(toolCall.name);
  if (!meta) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: `工具未启用或不存在: ${toolCall.name}`,
      isError: true
    };
  }

  input.emitToolActivity({
    type: "start",
    toolName: toolCall.name,
    toolCallId: toolCall.id
  });

  const query = getStringArgument(toolCall.arguments, "query")
    ?? getStringArgument(toolCall.arguments, "message")
    ?? fallbackQuery;

  try {
    if (toolCall.name === "memory_search") {
      const workspace = ensureDefaultWorkspace();
      const results = await searchWorkspaceMemory({
        workspaceSlug: workspace.slug,
        query,
        maxResults: 5
      });
      const text = results.length === 0
        ? "未检索到相关记忆。"
        : results.map((item, index) => `${index + 1}. [${item.path}] ${item.snippet}`.trim()).join("\n\n");
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: text
      });
      return { toolCallId: toolCall.id, toolName: toolCall.name, content: text };
    }

    if (toolCall.name === "web_search") {
      const { provider, result } = await searchWeb(query);
      const text = `[provider=${provider}]\n${result}`;
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: text
      });
      return { toolCallId: toolCall.id, toolName: toolCall.name, content: text };
    }

    if (toolCall.name === "suggest_agent_mode") {
      const reason = getStringArgument(toolCall.arguments, "reason");
      const suggestedPrompt = getStringArgument(toolCall.arguments, "suggestedPrompt");
      const recommendation = (reason && suggestedPrompt)
        ? { reason, suggestedPrompt }
        : buildAgentModeRecommendation(fallbackQuery);
      const text = JSON.stringify({
        type: "agent_recommendation",
        ...recommendation
      });
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: text
      });
      return { toolCallId: toolCall.id, content: text };
    }

    if (toolCall.name === "nano_banana") {
      const prompt = getStringArgument(toolCall.arguments, "prompt") ?? query;
      const aspectRatio = getStringArgument(toolCall.arguments, "aspectRatio")
        ?? inferNanoBananaAspectRatio(prompt);
      const imageSize = getStringArgument(toolCall.arguments, "imageSize")
        ?? inferNanoBananaImageSize(prompt);
      const useReferenceImages = getBooleanArgument(toolCall.arguments, "useReferenceImages")
        ?? shouldUseReferenceImagesForNanoBanana({
          userMessage: prompt,
          currentAttachments: input.currentAttachments,
          previousUserAttachments: input.previousUserAttachments,
          previousAssistantAttachments: input.previousAssistantAttachments
        });
      const enhancedPrompt = buildNanoBananaEnhancedPrompt(prompt, {
        messageHistory: input.messageHistory,
        useReferenceImages
      });
      const result = await generateNanoBananaImage(
        {
          conversationId: input.conversationId,
          prompt: enhancedPrompt,
          aspectRatio,
          imageSize,
          useReferenceImages,
          currentAttachments: input.currentAttachments,
          previousUserAttachments: input.previousUserAttachments,
          previousAssistantAttachments: input.previousAssistantAttachments
        },
        getChatToolCredentials("nano_banana")
      );
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: result.text
      });
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.text,
        generatedAttachments: result.attachments
      };
    }

    if (meta.category === "custom") {
      const customQuery = query || JSON.stringify(toolCall.arguments);
      const result = await runCustomHttpTool(meta, customQuery);
      input.emitToolActivity({
        type: "result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result
      });
      return { toolCallId: toolCall.id, toolName: toolCall.name, content: result };
    }

    const message = `暂不支持的工具: ${toolCall.name}`;
    input.emitToolActivity({
      type: "result",
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      result: message,
      isError: true
    });
    return { toolCallId: toolCall.id, toolName: toolCall.name, content: message, isError: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.emitToolActivity({
      type: "result",
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      result: message,
      isError: true
    });
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: message,
      isError: true
    };
  }
}

async function runEnabledToolsForChat(input: {
  conversationId: string;
  userMessage: string;
  messageHistory: ChatMessage[];
  attachments?: FileAttachment[];
  previousUserAttachments?: FileAttachment[];
  previousAssistantAttachments?: FileAttachment[];
  enabledToolIds?: string[];
  emitToolActivity: (activity: ChatToolActivity) => void;
}): Promise<{ contextAppendix?: string; generatedAttachments: FileAttachment[] }> {
  const toolInfos = getAllChatToolInfos();
  const enabledAndAvailable = new Set(
    toolInfos
      .filter((tool) => tool.enabled && tool.available)
      .map((tool) => tool.meta.id)
  );
  const requested = input.enabledToolIds
    ? new Set((input.enabledToolIds ?? []).filter((item) => typeof item === "string"))
    : enabledAndAvailable;
  const enabled = new Set(
    Array.from(requested).filter((toolId) => enabledAndAvailable.has(toolId))
  );
  const contextSections: string[] = [];
  const generatedAttachments: FileAttachment[] = [];

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

  if (enabled.has("suggest_agent_mode") && shouldSuggestAgentMode(input.userMessage)) {
    const toolCallId = randomUUID();
    input.emitToolActivity({
      type: "start",
      toolName: "suggest_agent_mode",
      toolCallId
    });
    try {
      const recommendation = buildAgentModeRecommendation(input.userMessage);
      const result = JSON.stringify({
        type: "agent_recommendation",
        ...recommendation
      });
      contextSections.push(`suggest_agent_mode:\n${result}`);
      input.emitToolActivity({
        type: "result",
        toolName: "suggest_agent_mode",
        toolCallId,
        result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({
        type: "result",
        toolName: "suggest_agent_mode",
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

  if (enabled.has("nano_banana") && shouldRunNanoBanana(input.userMessage, input.attachments)) {
    const toolCallId = randomUUID();
    input.emitToolActivity({
      type: "start",
      toolName: "nano_banana",
      toolCallId
    });
    try {
      const inferredAspectRatio = inferNanoBananaAspectRatio(input.userMessage);
      const inferredImageSize = inferNanoBananaImageSize(input.userMessage);
      const useReferenceImages = shouldUseReferenceImagesForNanoBanana({
        userMessage: input.userMessage,
        currentAttachments: input.attachments,
        previousUserAttachments: input.previousUserAttachments,
        previousAssistantAttachments: input.previousAssistantAttachments
      });
      const result = await generateNanoBananaImage(
        {
          conversationId: input.conversationId,
          prompt: buildNanoBananaEnhancedPrompt(input.userMessage, {
            messageHistory: input.messageHistory,
            useReferenceImages
          }),
          aspectRatio: inferredAspectRatio,
          imageSize: inferredImageSize,
          useReferenceImages,
          currentAttachments: input.attachments,
          previousUserAttachments: input.previousUserAttachments,
          previousAssistantAttachments: input.previousAssistantAttachments
        },
        getChatToolCredentials("nano_banana")
      );
      contextSections.push(`nano_banana:\n${result.text}`);
      if (result.attachments && result.attachments.length > 0) {
        generatedAttachments.push(...result.attachments);
      }
      input.emitToolActivity({
        type: "result",
        toolName: "nano_banana",
        toolCallId,
        result: result.text
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({
        type: "result",
        toolName: "nano_banana",
        toolCallId,
        result: message,
        isError: true
      });
    }
  }

  const customEnabledTools = toolInfos.filter(
    (tool) =>
      tool.meta.category === "custom" &&
      tool.enabled &&
      tool.available &&
      enabled.has(tool.meta.id)
  );

  for (const tool of customEnabledTools) {
    const toolCallId = randomUUID();
    input.emitToolActivity({
      type: "start",
      toolName: tool.meta.id,
      toolCallId
    });

    try {
      const result = await runCustomHttpTool(tool.meta, input.userMessage);
      contextSections.push(`${tool.meta.id}:\n${result}`);
      input.emitToolActivity({
        type: "result",
        toolName: tool.meta.id,
        toolCallId,
        result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emitToolActivity({
        type: "result",
        toolName: tool.meta.id,
        toolCallId,
        result: message,
        isError: true
      });
    }
  }

  return {
    contextAppendix: contextSections.length > 0
      ? [
        "以下是本轮工具执行结果，可作为回答参考：",
        ...contextSections
      ].join("\n\n")
      : undefined,
    generatedAttachments
  };
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
      attachments: accumulatedGeneratedAttachments.length > 0 ? accumulatedGeneratedAttachments : undefined,
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
      content: finalContent,
      createdAt: Date.now(),
      model: modelSelection.modelRef,
      reasoning: finalReasoning || undefined,
      attachments: accumulatedGeneratedAttachments.length > 0 ? accumulatedGeneratedAttachments : undefined,
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
          attachments: accumulatedGeneratedAttachments.length > 0 ? accumulatedGeneratedAttachments : undefined,
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
