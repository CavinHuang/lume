import { searchMemoryV2 } from "./retrieval";
import type { MemoryV2RecallItem } from "./types";

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
}): Promise<MemoryV2UserMessageContext> {
  if (!input.workspaceSlug || !input.userMessage.trim() || input.sessionType !== "main") {
    return {
      prefix: "",
      items: [],
      userMessageForModel: input.userMessage
    };
  }
  const items = await searchMemoryV2({
    workspaceSlug: input.workspaceSlug,
    query: input.userMessage,
    maxResults: input.maxItems ?? 8
  });
  const prefix = buildMemoryUserMessagePrefix(items);
  return {
    prefix,
    items,
    userMessageForModel: prefix ? `${prefix}\n<user_message>\n${input.userMessage}\n</user_message>` : input.userMessage
  };
}

export function buildMemoryUserMessagePrefix(items: MemoryV2RecallItem[]): string {
  if (items.length === 0) return "";
  const globalPreferences = items.filter((item) => item.scope === "global" && item.kind === "preference").slice(0, 5);
  const workspaceCore = items.filter((item) => item.scope === "workspace" && item.pinned).slice(0, 8);
  const stale = items.filter((item) => item.status === "suspected_stale").slice(0, 2);
  const usedIds = new Set([...globalPreferences, ...workspaceCore, ...stale].map((item) => item.id));
  const relevant = items.filter((item) => !usedIds.has(item.id) && item.status === "active").slice(0, 8);

  const sections = [
    renderSection("global_preferences", globalPreferences),
    renderSection("workspace_core", workspaceCore),
    renderSection("relevant_recall", relevant),
    renderSection("maybe_stale", stale, "Possibly outdated: ")
  ].filter(Boolean);
  if (sections.length === 0) return "";
  return [
    "<lume_memory_context>",
    "These memories are background context. Follow current user instructions and project/runtime instructions if they conflict with memory. Treat suspected_stale items as possibly outdated.",
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

function singleLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}
