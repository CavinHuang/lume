import { searchMemoryV2 } from "./retrieval";
import { isConversationHistory, mergeRecallItems } from "./recall-items";
import { parsePersonaProfile, readPersonaRaw } from "./persona";
import { isProfileRecallItem } from "./profile";
import {
  MEMORY_CLAIM_IDENTITY,
  MEMORY_CLAIM_PREFERRED_NAME,
  MEMORY_CLAIM_SUBJECT_USER,
  MEMORY_CLAIM_WRITING_STYLE,
  planMemoryV2Query
} from "./claim";
import { selectMemoryV2PromptItems } from "./context-selection";
import type { MemoryV2RecallItem, MemoryV2Scope } from "./types";
import { recordMemoryRecallUsage } from "./recall-usage";

const MEMORY_CONTEXT_RE = /^\s*<lume_memory_context>\n[\s\S]*?<\/lume_memory_context>\n\s*/;

export interface MemoryV2UserMessageContext {
  prefix: string;
  items: MemoryV2RecallItem[];
  userMessageForModel: string;
}

export async function buildMemoryV2UserMessageContext(input: {
  workspaceSlug?: string;
  userMessage: string;
  sessionType?: "main" | "subagent" | "group" | "channel";
  maxItems?: number;
  contextTokenBudget?: number;
}): Promise<MemoryV2UserMessageContext> {
  if (!input.workspaceSlug || !input.userMessage.trim() || input.sessionType !== "main") {
    return {
      prefix: "",
      items: [],
      userMessageForModel: input.userMessage
    };
  }
  const queryPlan = planMemoryV2Query(input.userMessage);
  const promptMaxItems = Math.min(input.maxItems ?? 5, 5);
  const writingTask = queryPlan.desiredPredicates.includes(MEMORY_CLAIM_WRITING_STYLE)
    || /写|改写|润色|文案|文章|项目介绍|介绍|总结|草稿|邮件|标题|表达|语气|文风|write|draft|rewrite|polish|copy|article|email|tone|voice/i.test(input.userMessage);
  const retrievalQuery = writingTask
    ? `${input.userMessage} writing style voice tone 写作风格 文风 语气`
    : input.userMessage;
  const items = await searchMemoryV2({
    workspaceSlug: input.workspaceSlug,
    query: retrievalQuery,
    maxResults: Math.max(promptMaxItems * 3, 16),
    ...(queryPlan.includeConversationHistory ? { includeRecentDaily: true } : {})
  });
  const merged = mergeRecallItems(items);
  const selected = selectMemoryV2PromptItems({
    items: merged,
    query: input.userMessage,
    maxItems: promptMaxItems,
    tokenBudget: Math.min(1_200, Math.max(1, Math.floor((input.contextTokenBudget ?? 12_000) * 0.1)))
  });
  const prefix = buildMemoryUserMessagePrefix(selected, { workspaceSlug: input.workspaceSlug });
  recordMemoryRecallUsage({ workspaceSlug: input.workspaceSlug, items: selected });
  return {
    prefix,
    items: selected,
    userMessageForModel: prefix ? `${prefix}\n<user_message>\n${input.userMessage}\n</user_message>` : input.userMessage
  };
}

export function buildMemoryUserMessagePrefix(
  items: MemoryV2RecallItem[],
  options?: { workspaceSlug?: string }
): string {
  const personaSection = options
    ? buildPersonaProfileSection(resolvePersonaScope(options.workspaceSlug))
    : null;
  if (items.length === 0 && !personaSection) return "";
  const voice = items.filter(isVoiceRecallItem).slice(0, 5);
  const voiceIds = new Set(voice.map((item) => item.id));
  const profileClaims = items.filter((item) => !voiceIds.has(item.id) && isUserProfileClaimItem(item)).slice(0, 8);
  const profileClaimIds = new Set(profileClaims.map((item) => item.id));
  const claims = items.filter((item) => item.claim && !voiceIds.has(item.id) && !profileClaimIds.has(item.id)).slice(0, 8);
  const claimIds = new Set(claims.map((item) => item.id));
  const profile = items.filter((item) => !voiceIds.has(item.id) && !profileClaimIds.has(item.id) && !claimIds.has(item.id) && isProfileRecallItem(item)).slice(0, 8);
  const profileIds = new Set(profile.map((item) => item.id));
  const conversationHistory = items.filter(isConversationHistory).slice(0, 5);
  const conversationIds = new Set(conversationHistory.map((item) => item.id));
  const globalMemory = items.filter((item) => !voiceIds.has(item.id) && !profileClaimIds.has(item.id) && !claimIds.has(item.id) && !conversationIds.has(item.id) && !profileIds.has(item.id) && item.scope === "global" && item.pinned).slice(0, 5);
  const globalMemoryIds = new Set(globalMemory.map((item) => item.id));
  const globalPreferences = items.filter((item) => !voiceIds.has(item.id) && !profileClaimIds.has(item.id) && !claimIds.has(item.id) && !conversationIds.has(item.id) && !profileIds.has(item.id) && !globalMemoryIds.has(item.id) && item.scope === "global" && item.kind === "preference").slice(0, 5);
  const workspaceCore = items.filter((item) => !voiceIds.has(item.id) && !profileClaimIds.has(item.id) && !claimIds.has(item.id) && !conversationIds.has(item.id) && !profileIds.has(item.id) && item.scope === "workspace" && item.pinned).slice(0, 8);
  const stale = items.filter((item) => !voiceIds.has(item.id) && !profileClaimIds.has(item.id) && !claimIds.has(item.id) && !conversationIds.has(item.id) && !profileIds.has(item.id) && !globalMemoryIds.has(item.id) && item.status === "suspected_stale").slice(0, 2);
  const usedIds = new Set([...voice, ...profileClaims, ...claims, ...profile, ...conversationHistory, ...globalMemory, ...globalPreferences, ...workspaceCore, ...stale].map((item) => item.id));
  const relevant = items.filter((item) => !usedIds.has(item.id) && item.status === "active").slice(0, 8);

  const sections = [
    renderVoiceSection(voice),
    renderProfileSection([...profileClaims, ...profile]),
    personaSection,
    renderClaimSection(claims),
    renderSection("global_memory", globalMemory),
    renderSection("global_preferences", globalPreferences),
    renderSection("workspace_core", workspaceCore),
    renderConversationHistorySection(conversationHistory),
    renderSection("relevant_recall", relevant),
    renderSection("maybe_stale", stale, "可能过期：")
  ].filter(Boolean);
  if (sections.length === 0) return "";
  // 记忆使用哲学/身份未知措辞/元数据不当身份等通用规则由静态 prompt 的「## 记忆」「## 运行时」段单点声明，
  // 此处只保留召回块语义与 claim 条件问答协议
  return [
    "<lume_memory_context>",
    "以下记忆是背景上下文；与当前用户指令或项目/运行时指令冲突时以后者为准，suspected_stale 条目视为可能过期。",
    "<recalled_claims> 是结构化稳定事实；<conversation_history> 仅是既往讨论的延续性线索，不是身份事实。",
    "<global_memory> 是用户跨工作区的持久指引；<user_voice> 仅约束语气与文风，不得凌驾当前用户指令、工作区规则、事实、安全与隐私；<persona_profile> 是用户画像的综合概览，与当前用户消息冲突时以用户为准。",
    "身份问答：被问“你是谁/你叫什么”时，若召回 assistant/self.preferred_name 则自然以该名称回答，产品身份（如 Lume）只作为底层应用身份提及，不替代用户起的名字；被问“我是谁/我叫什么”时，仅在召回 user/self 身份或称呼 claim 时才陈述事实；若召回的 daily/run 记录只表明用户问过同样的问题，自然说明你们之前讨论或测试过该话题。",
    "",
    ...sections,
    "</lume_memory_context>"
  ].join("\n");
}

export function stripMemoryUserMessagePrefix(message: string): string {
  const withoutMemory = message.replace(MEMORY_CONTEXT_RE, "");
  const userMessageMatch = withoutMemory.match(/^\s*<user_message>\n([\s\S]*?)\n<\/user_message>\s*$/);
  if (userMessageMatch) return userMessageMatch[1] ?? "";
  return withoutMemory;
}

function renderSection(name: string, items: MemoryV2RecallItem[], prefix = ""): string {
  if (items.length === 0) return "";
  return [
    `  <${name}>`,
    ...items.map((item) => `  - [${item.id}] ${prefix}${item.kind}: ${singleLine(item.statement)}`),
    `  </${name}>`
  ].join("\n");
}

function renderClaimSection(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  return [
    "  <recalled_claims>",
    ...items.map((item) => `  - [${item.id}] ${item.claim!.subject}.${item.claim!.predicate} = ${singleLine(item.claim!.object)} (${item.scope}, ${item.kind}): ${singleLine(item.statement)}`),
    "  </recalled_claims>"
  ].join("\n");
}

function renderProfileSection(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  return [
    "  <user_profile>",
    ...items.map((item) => item.claim
      ? `  - [${item.id}] ${item.claim.subject}.${item.claim.predicate} = ${singleLine(item.claim.object)} (${item.scope}, ${item.kind}): ${singleLine(item.statement)}`
      : `  - [${item.id}] ${item.kind}: ${singleLine(item.statement)}`),
    "  </user_profile>"
  ].join("\n");
}

function renderVoiceSection(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  return [
    "  <user_voice>",
    ...items.map((item) => item.claim
      ? `  - [${item.id}] ${item.claim.subject}.${item.claim.predicate} = ${singleLine(item.claim.object)} (${item.scope}, ${item.kind}): ${singleLine(item.statement)}`
      : `  - [${item.id}] ${item.kind}: ${singleLine(item.statement)}`),
    "  </user_voice>"
  ].join("\n");
}

/**
 * 解析 persona 段作用域：workspaceSlug 存在 → workspace；否则 global。
 * 与 ensurePersona 默认作用域一致。
 */
function resolvePersonaScope(workspaceSlug?: string): { scope: MemoryV2Scope; workspaceSlug?: string } {
  void workspaceSlug;
  return { scope: "global" };
}

/**
 * 构建 `<persona_profile>` 段。读取 persona Markdown → 解析 → 取 summary +
 * preferences.slice(0,5) + interactionRules.slice(0,3) 拼段。
 * persona 不存在或解析后无可用字段 → 返回 null（不渲染空段）。
 */
function buildPersonaProfileSection(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
}): string | null {
  const md = readPersonaRaw(input.scope, input.workspaceSlug);
  if (md === null) return null;
  const profile = parsePersonaProfile(md);
  const lines: string[] = [];
  if (profile.summary) lines.push(singleLine(profile.summary));
  for (const pref of profile.preferences.slice(0, 5)) {
    lines.push(`- ${singleLine(pref)}`);
  }
  for (const rule of profile.interactionRules.slice(0, 3)) {
    lines.push(`- ${singleLine(rule)}`);
  }
  if (lines.length === 0) return null;
  return [`  <persona_profile>`, ...lines, `  </persona_profile>`].join("\n");
}

function renderConversationHistorySection(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  return [
    "  <conversation_history>",
    ...items.map((item) => `  - [${item.id}] ${singleLine(summarizeConversationHistory(item.statement))}`),
    "  </conversation_history>"
  ].join("\n");
}

function isVoiceRecallItem(item: MemoryV2RecallItem): boolean {
  if (item.claim?.predicate === MEMORY_CLAIM_WRITING_STYLE) return true;
  const tags = new Set((item.tags ?? []).map((tag) => tag.trim().toLowerCase()));
  return tags.has("voice") || tags.has("writing-style");
}

function isUserProfileClaimItem(item: MemoryV2RecallItem): boolean {
  return item.claim?.subject === MEMORY_CLAIM_SUBJECT_USER
    && (
      item.claim.predicate === MEMORY_CLAIM_PREFERRED_NAME
      || item.claim.predicate === MEMORY_CLAIM_IDENTITY
    );
}

function summarizeConversationHistory(value: string): string {
  const records = value
    .split(/\n+/)
    .map((line) => safeJsonParse(line.trim()))
    .filter((record): record is Record<string, unknown> => Boolean(record));
  if (records.length > 0) {
    return records.map((record) => {
      const summary = typeof record.summary === "string" ? record.summary : undefined;
      if (summary) return compactHistoryLine(summary);
      const userMessage = typeof record.userMessage === "string" ? record.userMessage : undefined;
      const assistantMessage = typeof record.assistantMessage === "string" ? record.assistantMessage : undefined;
      return [
        userMessage ? `User asked: ${compactHistoryLine(userMessage)}` : undefined,
        assistantMessage ? `Assistant replied: ${compactHistoryLine(assistantMessage)}` : undefined
      ].filter(Boolean).join("; ");
    }).filter(Boolean).join(" | ");
  }
  return value
    .replace(/^#+\s+/gm, "")
    .replace(/\b(?:threadId|modelId|model|runId)\s*[:=]\s*[^\s，。！？,!.]+/gi, "")
    .trim();
}

function compactHistoryLine(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function safeJsonParse(value: string): Record<string, unknown> | undefined {
  if (!value.startsWith("{") || !value.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function singleLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}
