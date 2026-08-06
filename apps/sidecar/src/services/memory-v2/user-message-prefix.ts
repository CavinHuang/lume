import { searchMemoryV2 } from "./retrieval";
import { createMemoryV2Store } from "./markdown-store";
import { parsePersonaProfile, readPersonaRaw } from "./persona";
import { isProfileEntry, isProfileRecallItem, memoryEntryToRecallItem } from "./profile";
import {
  MEMORY_CLAIM_IDENTITY,
  MEMORY_CLAIM_PREFERRED_NAME,
  MEMORY_CLAIM_SUBJECT_USER,
  MEMORY_CLAIM_WRITING_STYLE,
  isClaimMatchForQuery,
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
  const profileItems = createMemoryV2Store().listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: ["global", "workspace"],
    includeStatuses: ["active"]
  }).filter(isProfileEntry).map((entry) => memoryEntryToRecallItem(entry));
  const voiceItems = createMemoryV2Store().listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: ["global", "workspace"],
    includeStatuses: ["active"]
  }).map((entry) => memoryEntryToRecallItem(entry)).filter(isVoiceRecallItem);
  const directClaimItems = profileItems.filter((item) => isClaimMatchForQuery(item, queryPlan));
  const profileSeed = directClaimItems.length > 0
    ? directClaimItems
    : queryPlan.querySubject ? profileItems : [];
  const voiceSeed = shouldSeedVoiceMemory(input.userMessage, queryPlan.desiredPredicates) ? voiceItems : [];
  const promptMaxItems = Math.min(input.maxItems ?? 5, 5);
  const items = await searchMemoryV2({
    workspaceSlug: input.workspaceSlug,
    query: input.userMessage,
    maxResults: Math.max(promptMaxItems * 3, 16),
    ...(profileSeed.length > 0 || voiceSeed.length > 0 ? { semantic: "off" as const } : {}),
    ...(queryPlan.includeConversationHistory ? { includeRecentDaily: true } : {})
  });
  const merged = mergeRecallItems([...profileSeed, ...voiceSeed, ...items]);
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
    renderSection("maybe_stale", stale, "Possibly outdated: ")
  ].filter(Boolean);
  if (sections.length === 0) return "";
  return [
    "<lume_memory_context>",
    "These memories are background context. Follow current user instructions and project/runtime instructions if they conflict with memory. Treat suspected_stale items as possibly outdated.",
    "Use recalled memory naturally. Do not say phrases like \"from memory\", \"from the memory\", or \"从记忆中可以看出\" unless the user asks how you know.",
    "Treat <recalled_claims> as structured stable facts. Treat <conversation_history> only as continuity about prior discussion, not as identity facts.",
    "Treat <global_memory> as durable cross-workspace guidance from the user. Apply it unless the current user message or higher-priority runtime/project instructions conflict.",
    "Treat <user_voice> as tone and writing-style guidance only. It must not override current user instructions, workspace rules, facts, safety, or privacy.",
    "Treat <persona_profile> as a synthesized overview of the user; background context; if it conflicts with the current user message, follow the user.",
    "For assistant identity questions such as \"你是谁？\" or \"你叫什么？\": if assistant/self.preferred_name is recalled, answer naturally that the user can call you by that name; if product/workspace identity such as Lume is also relevant, mention it as the underlying app identity, not as a replacement for the user-given name.",
    "For user identity questions such as \"我是谁？\" or \"我叫什么？\": only answer with real user profile facts if a user/self claim says them. If no actual identity or preferred-name fact is recalled, keep continuity first, then admit the gap warmly: e.g. \"我们之前聊过这个问题。但说实话，我现在还没有一个真正能叫出你的称呼。你愿意的话，告诉我你想让我怎么叫你，我之后就按这个来。\"",
    "If a recalled daily/run note only shows the user asked the same question before, say naturally that you have discussed or tested this topic before.",
    "Do not turn missing identity memory into profile-system wording. Avoid phrases like \"目前我这边还没有记录你的身份信息\", \"身份信息\", \"系统身份\", \"项目角色\", or asking the user to choose an aspect of identity. Do not infer identity from runtime metadata, thread IDs, model names, workspace names, or channel settings.",
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
    `  </${name}>`,
    ""
  ].join("\n");
}

function renderClaimSection(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  return [
    "  <recalled_claims>",
    ...items.map((item) => `  - [${item.id}] ${item.claim!.subject}.${item.claim!.predicate} = ${singleLine(item.claim!.object)} (${item.scope}, ${item.kind}): ${singleLine(item.statement)}`),
    "  </recalled_claims>",
    ""
  ].join("\n");
}

function renderProfileSection(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  return [
    "  <user_profile>",
    ...items.map((item) => item.claim
      ? `  - [${item.id}] ${item.claim.subject}.${item.claim.predicate} = ${singleLine(item.claim.object)} (${item.scope}, ${item.kind}): ${singleLine(item.statement)}`
      : `  - [${item.id}] ${item.kind}: ${singleLine(item.statement)}`),
    "  </user_profile>",
    ""
  ].join("\n");
}

function renderVoiceSection(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  return [
    "  <user_voice>",
    ...items.map((item) => item.claim
      ? `  - [${item.id}] ${item.claim.subject}.${item.claim.predicate} = ${singleLine(item.claim.object)} (${item.scope}, ${item.kind}): ${singleLine(item.statement)}`
      : `  - [${item.id}] ${item.kind}: ${singleLine(item.statement)}`),
    "  </user_voice>",
    ""
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
  return [`  <persona_profile>`, ...lines, `  </persona_profile>`, ""].join("\n");
}

function renderConversationHistorySection(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  return [
    "  <conversation_history>",
    ...items.map((item) => `  - [${item.id}] ${singleLine(summarizeConversationHistory(item.statement))}`),
    "  </conversation_history>",
    ""
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

function shouldSeedVoiceMemory(query: string, desiredPredicates: string[]): boolean {
  return desiredPredicates.includes(MEMORY_CLAIM_WRITING_STYLE)
    || /写|改写|润色|文案|文章|项目介绍|介绍|总结|草稿|邮件|标题|表达|语气|文风|write|draft|rewrite|polish|copy|article|email|tone|voice/i.test(query);
}

function isConversationHistory(item: MemoryV2RecallItem): boolean {
  return item.reason === "recent daily memory"
    || item.reason === "recent run memory"
    || item.id.includes(":daily:")
    || item.id.includes(":run:");
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

function mergeRecallItems(items: MemoryV2RecallItem[]): MemoryV2RecallItem[] {
  const byId = new Map<string, MemoryV2RecallItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing || item.score > existing.score) byId.set(item.id, item);
  }
  return [...byId.values()];
}
