import { WebSearchTool } from "@lume/agent-sdk";
import type {
  AgentMessage,
  AgentRecentMessagesResult,
  AgentThreadMeta,
  MemorySearchResult,
  ReadingBook,
  ReadingNoteSummary,
  ReadingRunTaskInput,
  ReadingUserReadingContext
} from "@lume/shared";
import { getRecentAgentThreadMessages, listAgentThreads } from "../agent/agent-thread-manager";
import { searchMemoryTool } from "../memory-v2/tools";
import { listReadingNotes } from "./reading-store";

interface ReadingMemorySearchInput {
  workspaceSlug?: string;
  query: string;
  maxResults?: number;
  includeWorkspace?: boolean;
  includeGlobal?: boolean;
  sessionType?: "main" | "subagent" | "group" | "channel";
}

type SearchMemory = (input: ReadingMemorySearchInput) => Promise<MemorySearchResult[]>;
type ListThreads = () => AgentThreadMeta[];
type GetRecentMessages = (threadId: string, limit: number) => AgentRecentMessagesResult;

export interface ReadingContextToolsDeps {
  workspaceSlug?: string;
  searchMemory?: SearchMemory;
  listThreads?: ListThreads;
  getRecentMessages?: GetRecentMessages;
  webSearch?: (query: string, limit: number) => Promise<unknown>;
}

export interface CollectReadingUserContextInput extends ReadingContextToolsDeps {
  book: ReadingBook;
  input?: ReadingRunTaskInput;
}

export type ReadingContextToolRunner = (
  name: string,
  args: Record<string, unknown>
) => Promise<string>;

export function createReadingContextToolRunner(deps: ReadingContextToolsDeps = {}): ReadingContextToolRunner {
  return async (name, args) => {
    if (name === "alice_user_memory") {
      return formatMemoryResults(await searchReadingMemory(deps, readQuery(args), readLimit(args, 5)));
    }
    if (name === "alice_diary_recall" || name === "alice_journal_recall") {
      const query = readQuery(args);
      const limit = readLimit(args, 6);
      return formatReadingDiarySnippets(
        collectRecentReadingNoteSnippets(query, limit),
        collectRecentConversationSnippets({
          ...deps,
          query,
          limit
        })
      );
    }
    if (name === "alice_web_search") {
      const query = readQuery(args);
      const limit = readLimit(args, 5);
      if (!deps.webSearch) return runDefaultReadingWebSearch(query, limit);
      return stringifyToolOutput(await deps.webSearch(query, limit));
    }
    return `未知读书上下文工具: ${name}`;
  };
}

export async function collectReadingUserContext(input: CollectReadingUserContextInput): Promise<ReadingUserReadingContext> {
  const explicit = input.input?.userContext ?? {};
  const query = buildReadingContextQuery(input.book, explicit);
  const [memory, conversations] = await Promise.all([
    searchReadingMemory(input, query, 3),
    Promise.resolve(collectRecentConversationSnippets({
      ...input,
      query,
      limit: 6
    }))
  ]);
  const summary = mergeSummaryParts([
    explicit.recentConversationSummary,
    conversations.length ? `最近对话：${conversations.join(" / ")}` : undefined,
    memory.length ? `相关记忆：${memory.map((item) => item.snippet).join(" / ")}` : undefined
  ]);

  return {
    ...explicit,
    ...(summary ? { recentConversationSummary: summary } : {})
  };
}

async function searchReadingMemory(
  deps: ReadingContextToolsDeps,
  query: string,
  maxResults: number
): Promise<MemorySearchResult[]> {
  const search = deps.searchMemory ?? defaultSearchMemory;
  if (!query.trim()) return [];
  try {
    return await search({
      workspaceSlug: deps.workspaceSlug ?? "",
      query,
      maxResults,
      includeWorkspace: true,
      includeGlobal: true,
      sessionType: "main"
    });
  } catch {
    return [];
  }
}

async function defaultSearchMemory(input: ReadingMemorySearchInput): Promise<MemorySearchResult[]> {
  return searchMemoryTool({
    workspaceSlug: input.workspaceSlug ?? "",
    query: input.query,
    maxResults: input.maxResults,
    includeWorkspace: input.includeWorkspace,
    includeGlobal: input.includeGlobal,
    sessionType: input.sessionType
  });
}

async function runDefaultReadingWebSearch(query: string, limit: number): Promise<string> {
  if (!query) return "需要提供搜索关键词。";
  const result = await WebSearchTool.call({
    query,
    num_results: limit
  }, {
    cwd: process.cwd()
  });
  return stringifyToolOutput(result.content);
}

function collectRecentConversationSnippets(input: ReadingContextToolsDeps & {
  query: string;
  limit: number;
}): string[] {
  const list = input.listThreads ?? listAgentThreads;
  const recent = input.getRecentMessages ?? getRecentAgentThreadMessages;
  const terms = queryTerms(input.query);
  const snippets: string[] = [];
  const fallback: string[] = [];
  for (const thread of list().slice(0, 8)) {
    const messages = safeRecentMessages(recent, thread.id, input.limit).messages;
    for (const message of messages) {
      if (!isConversationRole(message.role)) continue;
      const compact = compactText(message.content, 120);
      if (!compact) continue;
      const snippet = `${message.role === "user" ? "用户" : "Lume"}：${compact}`;
      fallback.push(snippet);
      if (terms.length > 0 && !terms.some((term) => compact.includes(term))) continue;
      snippets.push(snippet);
      if (snippets.length >= input.limit) return snippets;
    }
  }
  return snippets.length ? snippets : fallback.slice(0, input.limit);
}

function collectRecentReadingNoteSnippets(query: string, limit: number): string[] {
  let notes: ReadingNoteSummary[] = [];
  try {
    notes = listReadingNotes({ includeHidden: true });
  } catch {
    return [];
  }
  const terms = queryTerms(query);
  const visibleNotes = notes
    .filter((note) => !note.deleted)
    .sort((a, b) => b.createdAt - a.createdAt);
  const matched = visibleNotes.filter((note) => {
    if (terms.length === 0) return true;
    const haystack = [
      note.book?.title,
      note.book?.author,
      note.title,
      note.summary,
      note.selfContext,
      note.nextPlan,
      ...note.tags
    ].filter(Boolean).join(" ");
    return terms.some((term) => haystack.includes(term));
  });
  return (matched.length ? matched : visibleNotes)
    .slice(0, limit)
    .map(formatReadingNoteSnippet);
}

function safeRecentMessages(
  getRecentMessages: GetRecentMessages,
  threadId: string,
  limit: number
): AgentRecentMessagesResult {
  try {
    return getRecentMessages(threadId, limit);
  } catch {
    return { messages: [], total: 0, hasMore: false };
  }
}

function isConversationRole(role: AgentMessage["role"]): boolean {
  return role === "user" || role === "assistant";
}

function formatMemoryResults(results: MemorySearchResult[]): string {
  if (results.length === 0) return "没有找到相关用户记忆。";
  return [
    `用户记忆：${results.length} 条`,
    ...results.map((item, index) => `${index + 1}. ${item.snippet}`)
  ].join("\n");
}

function formatRecentConversationSnippets(snippets: string[]): string {
  if (snippets.length === 0) return "没有找到相关最近对话。";
  return [
    `最近对话：${snippets.length} 条`,
    ...snippets.map((item, index) => `${index + 1}. ${item}`)
  ].join("\n");
}

function formatReadingDiarySnippets(readingNotes: string[], conversations: string[]): string {
  if (readingNotes.length === 0) return formatRecentConversationSnippets(conversations);
  return [
    `最近读书笔记：${readingNotes.length} 条`,
    ...readingNotes.map((item, index) => `${index + 1}. ${item}`),
    ...(conversations.length ? [
      "",
      `最近对话：${conversations.length} 条`,
      ...conversations.map((item, index) => `${index + 1}. ${item}`)
    ] : [])
  ].join("\n");
}

function formatReadingNoteSnippet(note: ReadingNoteSummary): string {
  const title = note.book?.title ? `《${note.book.title}》${note.title ? ` ${note.title}` : ""}` : note.title;
  return [
    title,
    note.summary,
    note.selfContext ? `Lume 想法：${note.selfContext}` : undefined,
    note.nextPlan ? `下一步：${note.nextPlan}` : undefined
  ].filter((part): part is string => Boolean(part)).join(" / ");
}

function buildReadingContextQuery(book: ReadingBook, context: ReadingUserReadingContext): string {
  return [
    book.title,
    book.author,
    book.source.excerpt,
    ...(context.userThoughts ?? []),
    ...(context.userHighlights ?? []).flatMap((highlight) => [highlight.quote, highlight.note])
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
}

function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const token of query
    .split(/[\s，。、“”"':：；;,.!?！？《》（）()]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)) {
    terms.push(token);
    if (token.length > 4) {
      terms.push(token.slice(0, 4));
    }
  }
  return [...new Set(terms)].slice(0, 16);
}

function readQuery(args: Record<string, unknown>): string {
  return typeof args.query === "string" && args.query.trim() ? args.query.trim() : "";
}

function readLimit(args: Record<string, unknown>, fallback: number): number {
  return typeof args.limit === "number" && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(12, Math.round(args.limit)))
    : fallback;
}

function mergeSummaryParts(parts: Array<string | undefined>): string | undefined {
  const text = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n");
  return text ? compactText(text, 1200) : undefined;
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
