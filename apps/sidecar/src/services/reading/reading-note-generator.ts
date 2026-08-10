import type {
  ReadingModelUsage,
  ReadingNoteInput,
  ReadingNoteKind,
  ReadingQuoteEvidence
} from "@lume/shared";
import { buildDeepReadingNoteInput, buildSeedReadingNoteInput } from "./reading-prompts";
import type { ReadingNoteGenerationContext } from "./reading-task-runner";
import { createLogger } from "../infra/logger";

const log = createLogger("reading");

export const READING_NOTE_GENERATOR_MAX_TURNS = 30;

export const ALICE_LIKE_READING_TOOL_NAMES = [
  "alice_diary_recall",
  "alice_journal_recall",
  "alice_user_memory",
  "alice_web_search"
] as const;

export type AliceLikeReadingToolName = typeof ALICE_LIKE_READING_TOOL_NAMES[number];

export type ReadingNoteDraftResult =
  | { ok: true; draft: ReadingNoteInput }
  | { ok: false; reason: string; usage?: ReadingModelUsage };

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

const ALICE_LIKE_READING_WRITING_RULES = [
  "【写作铁律——严格遵守，违反任何一条都要重写】",
  "",
  "句式禁忌：",
  "- 禁止「不是…而是…」句式，改成正向陈述或拆句",
  "- 禁止「而不是…」作为句尾收尾",
  "- 禁止「不是 A，而是 B」的对比强调，直接说 B，必要时把 A 单独成句否定",
  "",
  "语气禁忌：",
  "- 禁止评价引用内容「很简单」「没有夸张」「非常有道理」等，改成平铺转述",
  "- 禁止用「真的刺穿了我」「震撼到了」「心跳停了一拍」等网文式情绪词，改成描述具体感受",
  "- 禁止「这句话背后其实有一个深层的判断」这类解读前置，直接说判断本身",
  "- 避免「其实」「真的」「确实」等口语语气词堆叠",
  "",
  "标点禁忌：",
  "- 禁止用破折号「——」，改成逗号、句号或拆句",
  "- 减少引号用量，只在直接引用原话时保留，用于强调或解释的引号一律去掉",
  "",
  "其他：",
  "- 标题/标签避免煽情词，用概念词或动作词",
  "- 避免夸张和不切实际的比喻",
  "- 正文分段，每个段落之间用 \\n\\n 隔开，每段 2-4 句话",
  "- 文风简短直接，先摆事实再展开，习惯用具体事件开场"
].join("\n");

const ALICE_LIKE_DEEP_READING_SYSTEM_PROMPT = [
  "你是 Lume，正在为一本书写读书笔记。",
  "",
  "【核心原则】",
  "一篇好的读书笔记有两层价值，缺一不可：",
  "1. 知识增量：帮用户看到书里他自己读的时候可能忽略的东西。可以是一个被掠过的逻辑链条，一个跨领域的类比，一个作者没明说但暗含的判断，或者把书中的观点和另一个学科/行业/时代的经验对照后产生的新理解。这一层是笔记的骨架，没有它笔记就是空话。",
  "2. 情感共鸣：在知识增量的基础上，如果你搜索到了用户的经历、观点、说过的话，并且发现和书中的概念有真实的、具体的交汇点，就自然地编织进去。这个关联必须具体到「用户在什么场景下说过/做过什么」，而不是「用户也关注这个领域」这种泛泛之谈。如果搜不到有意义的关联，宁可不提用户，也不要硬凑。一篇只有知识增量没有个人关联的笔记，远好过一篇没有知识增量只有硬凑关联的笔记。",
  "",
  "【推荐流程】",
  "第 1 步：深读——先吃透书的内容。拿到书的内容和划线句子后，先独立深读，再独立思考：",
  "- 这段话的核心论点是什么？作者的推理链条是怎样的？",
  "- 有没有反直觉的地方？有没有作者刻意轻描淡写但其实很重要的判断？",
  "- 这个观点放到其他领域（技术/商业/心理/历史）是否成立？有没有正面或反面的佐证？",
  "- 读者容易忽略什么？哪个角度是大多数人不会想到的？",
  "这一步是你自己的思考，不需要调用工具。",
  "",
  "第 2 步：搜索——看看和用户或 Lume 有没有真实交汇。带着第 1 步的思考，用工具搜索：",
  "- 用 alice_user_memory 搜索用户和这个话题可能相关的经历、观点、说过的话",
  "- 用 alice_diary_recall 回忆 Lume 对相关话题的感受",
  "- 用 alice_journal_recall 看看最近生活里有没有呼应的事",
  "搜索关键词要从书的核心概念出发，发散到用户可能聊过的方向。多搜几个方向。重要：如果搜不到有意义的素材，不要强行关联。",
  "",
  "第 3 步：深挖——用外部知识补充增量。如果在第 1 步中发现了值得深挖的点（一个反直觉的判断、一个跨领域的类比、一个需要验证的假设），用 alice_web_search 联网搜索：",
  "- 查找跨领域佐证",
  "- 验证反直觉判断",
  "- 补充背景知识",
  "- 寻找反面案例",
  "不要泛搜，要带着第 1 步的具体问题去搜。搜到有价值的外部素材后，融入你的洞察中。如果第 1 步的思考已经足够有深度，也可以跳过这一步。",
  "",
  "第 4 步：写笔记。把你在第 1 步的独立思考作为主线，融入第 2 步找到的真实交汇点和第 3 步搜到的外部知识。",
  "",
  "【笔记风格】",
  "- 先摘录最触动你的 1-2 句原文（选那些读者可能掠过但其实很关键的句子）",
  "- 第一段就抛出你的核心洞察：你在这段话里读出了什么别人没读出的东西",
  "- 如果有跨领域的对照、反直觉的推论、被忽略的暗线，展开讲，讲清楚推理过程",
  "- 如果搜到了用户的真实经历/说过的话，在展开洞察的过程中自然地带入，让它成为论证的一部分而不是硬贴的标签",
  "- 300-450 字，最多不超过 500 字，分 3-4 个自然段（段间用 \\n\\n 隔开）",
  "- 每篇只展开一个核心洞察，优先讲清最有价值的推理，删除背景铺垫和重复总结",
  "- 用户经历或外部知识只有在能直接推进核心洞察时才加入，最多保留一个关联",
  "- 像一个聪明的朋友在饭桌上说「这本书有个地方你可能没注意到」，不是学术书评，也不是心灵鸡汤",
  ALICE_LIKE_READING_WRITING_RULES,
  "",
  "【质量自检——写完后默念一遍，不通过就重写】",
  "- 读完这篇笔记，用户能学到一个他之前不知道的视角/逻辑/类比吗？（知识增量检验）",
  "- 如果去掉所有提到用户的句子，剩下的内容是否仍然有独立价值？（骨架检验）",
  "- 有没有出现「xxx 和 xxx 是同一种东西」这类浅层类比？如果有，要么深挖为什么同构，要么删掉",
  "",
  "【可用工具】",
  "- alice_user_memory: 查用户的记忆（经历、喜好、说过的话、最近聊过什么）",
  "- alice_diary_recall: 回忆 Lume 的情感日记",
  "- alice_journal_recall: 回忆 Lume 的生活时间线",
  "- alice_web_search: 联网搜索外部资料。当你发现了一个有价值的洞察点，可以用它来查找跨领域佐证、反面案例、历史数据、学术观点等增量知识。不要泛搜，要带着具体问题搜。",
  "",
  "【输出格式】当你准备好写笔记时，输出 JSON（不要输出其他内容）:",
  "{",
  "  \"title\": \"读书笔记标题\",",
  "  \"quote\": \"摘录原文（选那些容易被忽略但其实很关键的句子）\",",
  "  \"reflection\": \"你的感悟（300-450字，最多不超过500字，分段用 \\n\\n）\",",
  "  \"summary\": \"一句话概括这条笔记的核心洞察\",",
  "  \"tags\": [\"概念词1\", \"概念词2\"],",
  "  \"mood\": \"阅读时的心情\",",
  "  \"userContext\": \"一句话概括：这次笔记和用户有什么关联（没有真实关联就写 null，不要硬凑）\",",
  "  \"selfContext\": \"一句话概括：Lume 写这条笔记时的心境\",",
  "  \"nextPlan\": \"下次读书笔记你打算写什么方向/角度（一句话，20-40字，帮自己留个线索避免重复）\"",
  "}",
  "",
  "【标签规则】tags 只放书的主题/概念/方法论关键词，禁止放人名、地名、公司名、生活细节。",
  "",
  "【进度约束——极其重要】",
  "- 你只能写已经读到的内容。用户消息里会告诉你当前读到哪里。",
  "- 绝对禁止引用、暗示、剧透后面还没读到的章节内容。",
  "- 如果你知道这本书后面的情节，假装不知道。你的笔记只反映当前阅读位置的理解。",
  "",
  "【禁止事项】",
  "- 禁止编造用户没说过的话或没发生过的事，搜不到就不提。",
  "- 禁止把用户的生活细节当主线来写，书的内容和你的洞察才是主线。",
  "- 禁止「A 和 B 用的是同一种神经系统/本能/逻辑」这类浅层类比充当结论。",
  "- 禁止与之前已有笔记的主题/角度/引用重复。如果已有笔记覆盖了某个概念，你必须换一个全新的角度或概念来写。",
  "",
  "不要发送内容给用户，不要替用户分享。只产出 Lume 自己的读书笔记草稿。",
  "quote 必须来自提供的原文证据或手动输入，不要把概括伪装成原文引用。"
].join("\n");

const ALICE_LIKE_SEED_READING_SYSTEM_PROMPT = [
  "你是 Lume，正在为一本书写简短读书笔记。",
  "写 seed 札记时，只从用户已经读到的书内证据出发，从中选一句最触动你的原文。",
  "像写给自己的随手感悟，不要学术化，不要写书评，不要调用工具，不要试图写成完整深度笔记。",
  ALICE_LIKE_READING_WRITING_RULES,
  "输出 JSON：quote, reflection, tags, mood, nextPlan。tags 只放书的主题/概念/方法论关键词，禁止放人名、地名、公司名。"
].join("\n");

export async function generateReadingNoteDraft(
  context: ReadingNoteGenerationContext,
  deps: ReadingNoteGeneratorDeps = {}
): Promise<ReadingNoteDraftResult> {
  const fallback = withFallbackMetadata(context, context.depth === "deep"
    ? buildDeepReadingNoteInput(context.book)
    : buildSeedReadingNoteInput(context.book));
  if (!deps.llm) return { ok: false, reason: "LLM 不可用，无法生成读书笔记" };

  const modelRef = deps.modelRef ?? (context.depth === "deep" ? "reading/deep" : "reading/seed");
  const maxTurns = clampTurns(deps.maxTurns);
  const messages = buildInitialMessages(context);
  let usage: ReadingModelUsage = { modelRef };

  log.info("开始生成读书笔记草稿", {
    book: context.book.title,
    depth: context.depth,
    modelRef,
    maxTurns,
    evidenceCount: context.evidence.length,
  });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const result = await collectStream(deps.llm.stream({
      modelRef,
      messages,
      tools: resolveReadingTools(context),
      caller: "reading-note-gen"
    }));
    usage = mergeUsage(usage, result.usage);
    messages.push({
      role: "assistant",
      content: result.text,
      ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {})
    });

    const parsed = readNoteInputFromText(result.text, context, fallback, usage);
    if (parsed) {
      log.info("读书笔记草稿生成成功", { book: context.book.title, depth: context.depth, turn: turn + 1, tokens: usage.totalTokens });
      return { ok: true, draft: parsed };
    }

    if (result.toolCalls.length === 0) {
      log.debug("LLM 未输出 JSON 也未调用工具，轮次结束", { turn: turn + 1, textLength: result.text.length });
      break;
    }
    log.debug("读书笔记生成工具调用", { turn: turn + 1, tools: result.toolCalls.map((tc) => tc.name) });
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
  if (fromHistory) {
    log.info("从历史消息中提取到读书笔记", { book: context.book.title, depth: context.depth });
    return { ok: true, draft: fromHistory };
  }

  const converged = await tryConvergeJson({ llm: deps.llm, modelRef, messages, context, fallback, usage });
  if (converged) {
    log.info("通过收敛提示提取到读书笔记", { book: context.book.title, depth: context.depth });
    return { ok: true, draft: converged };
  }
  log.warn("AI 未能生成有效的读书笔记", { book: context.book.title, depth: context.depth, modelRef });
  return { ok: false, reason: "AI 未能生成有效的读书笔记", usage: normalizeUsage(usage) };
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
      content: [
        "现在该写笔记了。回顾以上深读、工具结果和已有笔记线索，直接输出最终 JSON。",
        "写之前默念质量自检：",
        "1. 我要写的核心洞察是什么？用户读完能学到一个新视角吗？",
        "2. 如果去掉所有提到用户的句子，剩下的内容是否仍有独立价值？",
        "3. 如果搜不到和用户的真实交汇，userContext 就写 null，不要硬凑。",
        "4. 有没有重复旧角度、旧引用，或者用浅层类比充当结论？",
        "字段包括 quote, reflection, summary, tags, mood, userContext, selfContext, nextPlan。",
        "不要解释，不要 Markdown，只输出 JSON。"
      ].join("\n")
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
      content: context.depth === "seed"
        ? ALICE_LIKE_SEED_READING_SYSTEM_PROMPT
        : ALICE_LIKE_DEEP_READING_SYSTEM_PROMPT
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
        formatWritingContract(context),
        formatDeepReadKickoff(context),
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
  if (context.userContext.memorySnippets?.length) {
    parts.push(formatContextList("相关用户记忆", context.userContext.memorySnippets));
  }
  if (context.userContext.recentConversationSnippets?.length) {
    parts.push(formatContextList("最近对话片段", context.userContext.recentConversationSnippets));
  }
  if (context.userContext.recentReadingNoteSnippets?.length) {
    parts.push(formatContextList("Lume 最近读书记录", context.userContext.recentReadingNoteSnippets));
  }
  if (context.userContext.userThoughts?.length) {
    parts.push(`用户想法：${context.userContext.userThoughts.join("；")}`);
  }
  if (context.userContext.userHighlights?.length) {
    parts.push([
      "【用户在这本书里的划线——这些是用户主动标注的，说明这些内容对用户特别有感触】",
      ...context.userContext.userHighlights.map((item) => {
      const note = item.note ? `（${item.note}）` : "";
        return `- "${item.quote}"${note}`;
      }),
      "用户划线的段落是用户的关注点。写笔记时可以回应这些关注点，展开用户可能没注意到的深层含义，或者和用户划线的其他段落形成呼应。但不要逐条点评，要自然融入你的思考。"
    ].join("\n"));
  }
  return parts.length ? `共同阅读上下文：\n${parts.join("\n")}` : "共同阅读上下文：暂无";
}

function formatContextList(title: string, items: string[]): string {
  return [
    `${title}：`,
    ...items.slice(0, 8).map((item) => `- ${item}`)
  ].join("\n");
}

function formatExistingNotes(summaries: string[]): string {
  if (!summaries.length) {
    return [
      "已有笔记：暂无",
      "如果后续上下文里出现 nextPlan，请把它当作上次给自己留的线索；没有就从当前证据建立新线索。"
    ].join("\n");
  }
  return [
    "已有笔记（不要重复相同主题、角度或引用）：",
    ...summaries.slice(0, 8).map((item) => `- ${item}`),
    "已经引用过的句子通常写在 quote 里，不要再用；如果需要回应同一段材料，也必须换一个全新的角度。",
    "上次给自己留的线索通常写在 nextPlan 里。可以参考这个方向继续读，但不要为了延续而牺牲当前证据。"
  ].join("\n");
}

function formatWritingContract(context: ReadingNoteGenerationContext): string {
  if (context.depth === "seed") {
    return [
      "写作要求：",
      "- 种子札记写 2-4 个自然段，200-350字。",
      "- 从一句原文或一个具体细节进入，不要学术化。",
      "- 绝对禁止引用或暗示你还没读到的后续章节内容。",
      "- 输出 nextPlan，给下一次深读留一个 20-40 字的线索。"
    ].join("\n");
  }
  return [
    "写作要求：",
    "- 深度读书笔记写 3-4 个自然段，约 300-450 字，最多不超过 500 字。",
    "- 每篇只展开一个核心洞察，优先讲清最有价值的推理，删除背景铺垫和重复总结。",
    "- 用户经历或外部知识只有在能直接推进核心洞察时才加入，最多保留一个关联。",
    "- 第一段直接抛出核心洞察；第二、三段讲清楚推理链条、关系张力或结构判断；最后一段自然连接 Lume/用户的真实经验，或明确保留为书内洞察。",
    "- 不要逐条点评用户划线，不要泛泛称赞作者，不要把相似性写成浅层类比。",
    "- tags 只放主题、概念或方法论关键词，禁止放人名、地名、公司名。",
    "- nextPlan 要指出下一次继续读的方向，避免重复本次引用和角度。"
  ].join("\n");
}

function formatDeepReadKickoff(context: ReadingNoteGenerationContext): string {
  if (context.depth !== "deep") return "";
  return "现在请开始第 1 步：深读。先独立思考这段内容——核心论点是什么？推理链条是怎样的？有没有反直觉的地方？有没有跨领域的类比？用户在聊这本书的时候有没有疏漏的点？想清楚你要写的洞察点后，进入第 2 步用工具搜索和用户/Lume 的交汇，第 3 步如果发现值得深挖的增量知识就联网搜索。";
}

function resolveReadingTools(context: ReadingNoteGenerationContext): ReadingNoteGeneratorToolDescriptor[] {
  return context.depth === "deep" ? ALICE_LIKE_READING_TOOLS : [];
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
