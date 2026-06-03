import type {
  ReadingModelUsage,
  ReadingNoteInput,
  ReadingNoteKind,
  ReadingQuoteEvidence
} from "@lume/shared";
import { buildDeepReadingNoteInput, buildSeedReadingNoteInput } from "./reading-prompts";
import type { ReadingNoteGenerationContext } from "./reading-task-runner";

export const READING_NOTE_GENERATOR_MAX_TURNS = 30;

export const ALICE_LIKE_READING_TOOL_NAMES = [
  "alice_diary_recall",
  "alice_journal_recall",
  "alice_user_memory",
  "alice_web_search"
] as const;

export type AliceLikeReadingToolName = typeof ALICE_LIKE_READING_TOOL_NAMES[number];

export interface ReadingNoteGeneratorMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ReadingNoteGeneratorToolCall[];
}

export interface ReadingNoteGeneratorToolDescriptor {
  name: AliceLikeReadingToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ReadingNoteGeneratorToolCall {
  id: string;
  name: string;
  arguments?: string | Record<string, unknown>;
}

export interface ReadingNoteGeneratorStreamRequest {
  modelRef: string;
  messages: ReadingNoteGeneratorMessage[];
  tools: ReadingNoteGeneratorToolDescriptor[];
  caller: "reading-note-gen" | "reading-note-gen-converge";
}

export type ReadingNoteGeneratorStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id?: string; name: string; arguments?: string | Record<string, unknown> }
  | { type: "tool_call_delta"; id?: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: ReadingModelUsage };

export interface ReadingNoteGeneratorLlm {
  stream(request: ReadingNoteGeneratorStreamRequest): AsyncIterable<ReadingNoteGeneratorStreamEvent>;
}

export interface ReadingNoteGeneratorDeps {
  llm?: ReadingNoteGeneratorLlm;
  modelRef?: string;
  maxTurns?: number;
  runTool?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const ALICE_LIKE_READING_TOOLS: ReadingNoteGeneratorToolDescriptor[] = [
  {
    name: "alice_diary_recall",
    description: "回忆 Lume 最近的生活记录，用来把书里的细节和 Lume 的自我经验连接起来。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        days_back: { type: "number", minimum: 1, maximum: 90 },
        limit: { type: "number", minimum: 1, maximum: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "alice_journal_recall",
    description: "按日期或关键词回忆更具体的日志片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        date: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 10 }
      }
    }
  },
  {
    name: "alice_user_memory",
    description: "检索用户长期记忆和最近对话，用来识别共同阅读时用户真正关心的线索。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "alice_web_search",
    description: "搜索作者、书籍背景或相关现实材料。只在书内证据不足以理解上下文时使用。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 5 }
      },
      required: ["query"]
    }
  }
];

export async function generateReadingNoteDraft(
  context: ReadingNoteGenerationContext,
  deps: ReadingNoteGeneratorDeps = {}
): Promise<ReadingNoteInput> {
  const fallback = withFallbackMetadata(context, context.depth === "deep"
    ? buildDeepReadingNoteInput(context.book)
    : buildSeedReadingNoteInput(context.book));
  if (!deps.llm) return fallback;

  const modelRef = deps.modelRef ?? (context.depth === "deep" ? "reading/deep" : "reading/seed");
  const maxTurns = clampTurns(deps.maxTurns);
  const messages = buildInitialMessages(context);
  let usage: ReadingModelUsage = { modelRef };

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const result = await collectStream(deps.llm.stream({
      modelRef,
      messages,
      tools: ALICE_LIKE_READING_TOOLS,
      caller: "reading-note-gen"
    }));
    usage = mergeUsage(usage, result.usage);
    messages.push({
      role: "assistant",
      content: result.text,
      ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {})
    });

    const parsed = readNoteInputFromText(result.text, context, fallback, usage);
    if (parsed) return parsed;

    if (result.toolCalls.length === 0) break;
    for (const toolCall of result.toolCalls) {
      const args = parseToolArguments(toolCall.arguments);
      const output = await runTool(deps.runTool, toolCall.name, args);
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: output
      });
    }
  }

  const fromHistory = readNoteInputFromMessages(messages, context, fallback, usage);
  if (fromHistory) return fromHistory;

  const converged = await tryConvergeJson({ llm: deps.llm, modelRef, messages, context, fallback, usage });
  return converged ?? attachUsage(fallback, usage);
}

async function collectStream(stream: AsyncIterable<ReadingNoteGeneratorStreamEvent>): Promise<{
  text: string;
  toolCalls: ReadingNoteGeneratorToolCall[];
  usage?: ReadingModelUsage;
}> {
  let text = "";
  const toolCalls: ReadingNoteGeneratorToolCall[] = [];
  const deltaCalls = new Map<string, ReadingNoteGeneratorToolCall & { argumentsText: string }>();
  let usage: ReadingModelUsage | undefined;

  for await (const event of stream) {
    if (event.type === "text") {
      text += event.text;
      continue;
    }
    if (event.type === "tool_call") {
      toolCalls.push({
        id: event.id ?? `tc-${toolCalls.length + 1}`,
        name: event.name,
        arguments: event.arguments
      });
      continue;
    }
    if (event.type === "tool_call_delta") {
      const id = event.id ?? `delta-${deltaCalls.size + 1}`;
      const existing = deltaCalls.get(id) ?? { id, name: event.name ?? "", argumentsText: "" };
      existing.name = event.name ?? existing.name;
      existing.argumentsText += event.argumentsDelta ?? "";
      deltaCalls.set(id, existing);
      continue;
    }
    if (event.type === "usage") {
      usage = mergeUsage(usage, event.usage);
    }
  }

  for (const call of deltaCalls.values()) {
    if (!call.name.trim()) continue;
    toolCalls.push({
      id: call.id,
      name: call.name,
      arguments: call.argumentsText
    });
  }

  return { text: text.trim(), toolCalls, usage };
}

async function tryConvergeJson(input: {
  llm: ReadingNoteGeneratorLlm;
  modelRef: string;
  messages: ReadingNoteGeneratorMessage[];
  context: ReadingNoteGenerationContext;
  fallback: ReadingNoteInput;
  usage: ReadingModelUsage;
}): Promise<ReadingNoteInput | null> {
  const messages: ReadingNoteGeneratorMessage[] = [
    ...input.messages,
    {
      role: "user",
      content: "请基于以上读书上下文立即输出一个 JSON 对象，不要解释，不要 Markdown。字段包括 quote, reflection, summary, tags, mood, userContext, selfContext, nextPlan。"
    }
  ];
  try {
    const result = await collectStream(input.llm.stream({
      modelRef: input.modelRef,
      messages,
      tools: [],
      caller: "reading-note-gen-converge"
    }));
    const usage = mergeUsage(input.usage, result.usage);
    return readNoteInputFromText(result.text, input.context, input.fallback, usage);
  } catch {
    return null;
  }
}

function readNoteInputFromMessages(
  messages: ReadingNoteGeneratorMessage[],
  context: ReadingNoteGenerationContext,
  fallback: ReadingNoteInput,
  usage: ReadingModelUsage
): ReadingNoteInput | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const parsed = readNoteInputFromText(message.content, context, fallback, usage);
    if (parsed) return parsed;
  }
  return null;
}

function readNoteInputFromText(
  text: string,
  context: ReadingNoteGenerationContext,
  fallback: ReadingNoteInput,
  usage: ReadingModelUsage
): ReadingNoteInput | null {
  const parsed = parseFirstJsonRecord(text);
  if (!parsed) return null;
  return buildGeneratedNoteInput(parsed, context, fallback, usage);
}

function buildGeneratedNoteInput(
  parsed: Record<string, unknown>,
  context: ReadingNoteGenerationContext,
  fallback: ReadingNoteInput,
  usage: ReadingModelUsage
): ReadingNoteInput | null {
  const body = readString(parsed.reflection)
    ?? readString(parsed.noteContent)
    ?? readString(parsed.body);
  if (!body) return null;

  const quote = readString(parsed.quote) ?? readString(parsed.originalQuote);
  const evidence = resolveEvidence(context, fallback, quote);
  const tags = readStringArray(parsed.tags);
  const noteKind = readNoteKind(parsed.noteKind) ?? readNoteKind(parsed.noteType)
    ?? (context.depth === "seed" ? "seed" : "insight");

  return {
    ...fallback,
    bookId: context.book.id,
    depth: context.depth,
    noteKind,
    title: readString(parsed.title) ?? fallback.title,
    summary: readString(parsed.summary) ?? fallback.summary,
    body,
    originalQuote: quote && evidence.some((item) => containsQuote(item.excerpt, quote))
      ? quote
      : evidence[0]?.quote ?? fallback.originalQuote,
    excerpt: evidence[0]?.excerpt ?? fallback.excerpt,
    progressPercent: readProgress(parsed.progressAt) ?? readProgress(parsed.progress) ?? fallback.progressPercent,
    tags: tags.length ? tags : fallback.tags,
    evidence,
    chapterTitle: readString(parsed.chapterTitle) ?? evidence[0]?.location,
    mood: readString(parsed.mood),
    userContext: readString(parsed.userContext),
    selfContext: readString(parsed.selfContext),
    rating: readNumber(parsed.rating),
    cost: readNumber(parsed.cost),
    modelUsage: normalizeUsage(usage),
    nextPlan: readString(parsed.nextPlan) ?? fallback.nextPlan
  };
}

function buildInitialMessages(context: ReadingNoteGenerationContext): ReadingNoteGeneratorMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 Lume 的读书笔记生成器，行为对齐 Alice 的读书流程：先读书内证据，再按需调用工具回忆日记、用户记忆或搜索背景。",
        "不要发送内容给用户，不要替用户分享。只产出 Lume 自己的读书笔记草稿。",
        "最后必须输出一个 JSON 对象。可用字段：title, quote, reflection, summary, tags, mood, userContext, selfContext, nextPlan, rating, chapterTitle。",
        "quote 必须来自提供的原文证据或手动输入，不要把概括伪装成原文引用。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `书名：${context.book.title}`,
        `作者：${context.book.author ?? "未知"}`,
        `深度：${context.depth}`,
        `进度：${typeof context.book.progressPercent === "number" ? `${Math.round(context.book.progressPercent)}%` : "未知"}`,
        formatEvidence(context.evidence),
        formatUserContext(context),
        formatExistingNotes(context.existingNoteSummaries),
        context.manualQuoteText ? `手动引用：${context.manualQuoteText}` : "",
        context.manualSource ? `手动来源：${context.manualSource}` : ""
      ].filter(Boolean).join("\n\n")
    }
  ];
}

function formatEvidence(evidence: ReadingQuoteEvidence[]): string {
  if (!evidence.length) return "书内证据：暂无";
  return [
    "书内证据：",
    ...evidence.slice(0, 8).map((item, index) => {
      const location = item.location ? ` @ ${item.location}` : "";
      return `${index + 1}. ${item.quote}${location}\n原文片段：${item.excerpt ?? item.quote}`;
    })
  ].join("\n");
}

function formatUserContext(context: ReadingNoteGenerationContext): string {
  const parts: string[] = [];
  if (context.userContext.recentConversationSummary) {
    parts.push(`最近对话：${context.userContext.recentConversationSummary}`);
  }
  if (context.userContext.recentDiarySummary) {
    parts.push(`最近生活记录：${context.userContext.recentDiarySummary}`);
  }
  if (context.userContext.userThoughts?.length) {
    parts.push(`用户想法：${context.userContext.userThoughts.join("；")}`);
  }
  if (context.userContext.userHighlights?.length) {
    parts.push(`用户划线：${context.userContext.userHighlights.map((item) => {
      const note = item.note ? `（${item.note}）` : "";
      return `${item.quote}${note}`;
    }).join("；")}`);
  }
  return parts.length ? `共同阅读上下文：\n${parts.join("\n")}` : "共同阅读上下文：暂无";
}

function formatExistingNotes(summaries: string[]): string {
  if (!summaries.length) return "已有笔记：暂无";
  return `已有笔记：\n${summaries.slice(0, 6).map((item) => `- ${item}`).join("\n")}`;
}

async function runTool(
  run: ReadingNoteGeneratorDeps["runTool"],
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!run) return `工具 ${name} 尚未接入，无法提供额外上下文。`;
  try {
    const result = await run(name, args);
    return stringifyToolResult(result);
  } catch (error) {
    return `工具调用失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseToolArguments(value: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseFirstJsonRecord(text: string): Record<string, unknown> | null {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function collectJsonCandidates(text: string): string[] {
  const trimmed = stripCodeFence(text.trim());
  const candidates = trimmed.startsWith("{") ? [trimmed] : [];
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== "{") continue;
    const end = findJsonObjectEnd(trimmed, start);
    if (end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  return [...new Set(candidates)];
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? text;
}

function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function resolveEvidence(
  context: ReadingNoteGenerationContext,
  fallback: ReadingNoteInput,
  quote: string | undefined
): ReadingQuoteEvidence[] {
  const fallbackEvidence = fallback.evidence ?? [];
  if (!quote) return fallbackEvidence;
  const candidates = [...context.evidence, ...fallbackEvidence];
  const matched = candidates.find((item) =>
    containsQuote(item.excerpt, quote) || containsQuote(item.quote, quote)
  );
  if (matched) {
    return [{
      ...matched,
      quote,
      excerpt: containsQuote(matched.excerpt, quote) ? matched.excerpt : quote
    }];
  }
  if (context.manualQuoteText && containsQuote(context.manualQuoteText, quote)) {
    return [{
      quote,
      sourceKind: context.book.source.kind,
      sourceId: context.book.source.externalId,
      sourceTitle: context.manualSource ?? context.book.title,
      excerpt: context.manualQuoteText,
      capturedAt: Date.now()
    }];
  }
  return fallbackEvidence;
}

function withFallbackMetadata(context: ReadingNoteGenerationContext, input: ReadingNoteInput): ReadingNoteInput {
  return {
    ...input,
    originalQuote: input.originalQuote ?? input.evidence?.[0]?.quote,
    noteKind: input.noteKind ?? (context.depth === "seed" ? "seed" : "insight"),
    userContext: input.userContext ?? summarizeUserReadingContext(context),
    selfContext: input.selfContext ?? `Lume 在读《${context.book.title}》时保留了这条上下文，等下次继续把书里的线索和共同阅读经验连起来。`
  };
}

function summarizeUserReadingContext(context: ReadingNoteGenerationContext): string | undefined {
  const parts: string[] = [];
  if (context.userContext.recentConversationSummary) {
    parts.push(context.userContext.recentConversationSummary);
  }
  if (context.userContext.recentDiarySummary) {
    parts.push(context.userContext.recentDiarySummary);
  }
  if (context.userContext.userThoughts?.length) {
    parts.push(`用户想法：${context.userContext.userThoughts.join("；")}`);
  }
  if (context.userContext.userHighlights?.length) {
    parts.push(`用户划线：${context.userContext.userHighlights.map((item) => item.note ? `${item.quote}（${item.note}）` : item.quote).join("；")}`);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function attachUsage(input: ReadingNoteInput, usage: ReadingModelUsage): ReadingNoteInput {
  const modelUsage = normalizeUsage(usage);
  return Object.keys(modelUsage).length ? { ...input, modelUsage } : input;
}

function mergeUsage(current: ReadingModelUsage | undefined, next: ReadingModelUsage | undefined): ReadingModelUsage {
  if (!current) return next ? { ...next } : {};
  if (!next) return { ...current };
  return {
    modelRef: next.modelRef ?? current.modelRef,
    promptTokens: sumNumbers(current.promptTokens, next.promptTokens),
    completionTokens: sumNumbers(current.completionTokens, next.completionTokens),
    totalTokens: sumNumbers(current.totalTokens, next.totalTokens)
  };
}

function normalizeUsage(usage: ReadingModelUsage): ReadingModelUsage {
  return {
    ...(readString(usage.modelRef) ? { modelRef: readString(usage.modelRef) } : {}),
    ...(typeof usage.promptTokens === "number" && usage.promptTokens > 0 ? { promptTokens: usage.promptTokens } : {}),
    ...(typeof usage.completionTokens === "number" && usage.completionTokens > 0 ? { completionTokens: usage.completionTokens } : {}),
    ...(typeof usage.totalTokens === "number" && usage.totalTokens > 0 ? { totalTokens: usage.totalTokens } : {})
  };
}

function sumNumbers(a: number | undefined, b: number | undefined): number | undefined {
  if (typeof a !== "number" && typeof b !== "number") return undefined;
  return (a ?? 0) + (b ?? 0);
}

function clampTurns(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return READING_NOTE_GENERATOR_MAX_TURNS;
  return Math.max(1, Math.min(READING_NOTE_GENERATOR_MAX_TURNS, Math.round(value)));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readProgress(value: unknown): number | undefined {
  const numeric = readNumber(value);
  if (typeof numeric === "number") return numeric;
  if (typeof value !== "string") return undefined;
  const matched = value.match(/(\d+(?:\.\d+)?)/);
  return matched?.[1] ? Number(matched[1]) : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function readNoteKind(value: unknown): ReadingNoteKind | undefined {
  return value === "seed" || value === "insight" || value === "review" ? value : undefined;
}

function containsQuote(excerpt: string | undefined, quote: string): boolean {
  if (!excerpt) return false;
  return normalizeQuote(excerpt).includes(normalizeQuote(quote));
}

function normalizeQuote(value: string): string {
  return value.replace(/\s+/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
