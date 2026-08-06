import { toApiTool, type ApiType, type LLMProvider, type NormalizedContentBlock, type NormalizedMessageParam, type ToolDefinition } from "@lume/agent-sdk";
import type { LumeEffectiveConfig } from "@lume/shared";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import { createLazyConnectionLlmProvider } from "../model-runtime/connection-provider";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { inferMemoryV2Claim, normalizeMemoryV2Claim } from "./claim";
import { extractAssistantPreferredNameCandidate, extractPreferredNameCandidate } from "./profile";
import type { MemoryV2Candidate } from "./types";
import { stripMemoryUserMessagePrefix } from "./user-message-prefix";

const DO_NOT_REMEMBER_RE = /\bdo not remember\b|\bdon't remember\b|\bdo not save\b|不要记住|别记住|不要保存/i;

type MemoryExtractionProviderFactory = (input: {
  apiType: ApiType;
  apiKey: string;
  baseURL?: string;
}) => LLMProvider;

export function extractExplicitMemoryCandidates(input: {
  text: string;
  workspaceSlug?: string;
}): MemoryV2Candidate[] {
  const text = input.text.trim();
  if (!text || DO_NOT_REMEMBER_RE.test(text)) return [];
  const segments = splitExplicitMemorySegments(text);
  if (segments.length > 1) {
    return dedupeMemoryV2Candidates(segments.flatMap((segment) =>
      extractExplicitMemoryCandidates({
        text: segment,
        workspaceSlug: input.workspaceSlug
      })
    ));
  }

  const preferredName = extractPreferredNameCandidate(input);
  if (preferredName) return [preferredName];
  const assistantPreferredName = extractAssistantPreferredNameCandidate(input);
  if (assistantPreferredName) return [assistantPreferredName];

  const statement = extractStatement(text);
  if (!statement) return [];
  const kind = inferKind(text, statement);
  const targetScope = kind === "preference" ? "global" : "workspace";
  return [{
    kind,
    targetScope,
    statement,
    confidence: "high",
    tags: inferTags(text, statement),
    entities: inferEntities(text),
    claim: inferMemoryV2Claim({ statement, tags: inferTags(text, statement) }),
    appliesWhen: targetScope === "workspace" && input.workspaceSlug
      ? { workspaceSlug: input.workspaceSlug }
      : {},
    evidence: {
      quote: text
    }
  }];
}

function splitExplicitMemorySegments(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])\s+/u)
    .flatMap((part) => part.split(/(?<=[。！？!?])/u))
    .flatMap(splitExplicitMemoryConnectors)
    .map((part) => part.trim().replace(/[。！？!?]+$/u, "").trim())
    .filter(Boolean);
}

function splitExplicitMemoryConnectors(text: string): string[] {
  const parts = text.trim().split(/\s+(?=(?:以后|记住|叫我|称呼我|喊我|就想叫你|想叫你|希望叫你|叫你|称呼你|喊你))/u);
  return parts.length > 1 ? parts : [text];
}

function dedupeMemoryV2Candidates(candidates: MemoryV2Candidate[]): MemoryV2Candidate[] {
  const seen = new Set<string>();
  const result: MemoryV2Candidate[] = [];
  for (const candidate of candidates) {
    const key = memoryV2CandidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function mergeMemoryV2Candidates(
  parsed: MemoryV2Candidate[],
  explicitCandidates: MemoryV2Candidate[]
): MemoryV2Candidate[] {
  if (parsed.length === 0) return explicitCandidates;
  const parsedKeys = new Set(parsed.map(memoryV2CandidateKey));
  const parsedQuotes = new Set(parsed.map(memoryV2CandidateQuote).filter(Boolean));
  const missingExplicit = explicitCandidates.filter((candidate) => {
    if (candidate.claim) return !parsedKeys.has(memoryV2CandidateKey(candidate));
    const quote = memoryV2CandidateQuote(candidate);
    return !quote || !parsedQuotes.has(quote);
  });
  return [...parsed, ...missingExplicit];
}

function memoryV2CandidateQuote(candidate: MemoryV2Candidate): string {
  return candidate.evidence?.quote?.trim() ?? "";
}

function memoryV2CandidateKey(candidate: MemoryV2Candidate): string {
  const claim = candidate.claim;
  if (claim) {
    return [
      candidate.targetScope,
      claim.subject,
      claim.predicate,
      claim.object
    ].join("\u0000").toLowerCase();
  }
  return [
    candidate.targetScope,
    candidate.kind,
    candidate.statement
  ].join("\u0000").toLowerCase();
}

export async function extractMemoryCandidatesWithLlm(input: {
  text: string;
  workspaceSlug?: string;
  modelRef?: string;
  fallbackModelRefs?: string[];
  createProvider?: MemoryExtractionProviderFactory;
}): Promise<MemoryV2Candidate[]> {
  const text = stripMemoryUserMessagePrefix(input.text).trim();
  if (!text || DO_NOT_REMEMBER_RE.test(text)) return [];
  const explicitCandidates = extractExplicitMemoryCandidates({ text, workspaceSlug: input.workspaceSlug });
  const config = getEffectiveLumeConfig(input.workspaceSlug);
  const modelRefs = resolveMemoryExtractionModelRefs(config, {
    modelRef: input.modelRef,
    fallbackModelRefs: input.fallbackModelRefs
  });
  if (modelRefs.length === 0) {
    return explicitCandidates;
  }

  for (const modelRef of modelRefs) {
    try {
      const parsed = await extractMemoryCandidatesWithModel({
        text,
        workspaceSlug: input.workspaceSlug,
        modelRef,
        createProvider: input.createProvider
      });
      if (parsed) return mergeMemoryV2Candidates(parsed, explicitCandidates);
    } catch {
      continue;
    }
  }
  return explicitCandidates;
}

export interface MemoryBatchExtractionSource {
  sourceId: string;
  text: string;
  role?: "user" | "assistant" | "tool_result";
}

export interface MemoryBatchExtractionCandidate {
  sourceId: string;
  candidate: MemoryV2Candidate;
}

export interface MemoryBatchExtractionExistingMemory {
  id: string;
  statement: string;
  claim?: MemoryV2Candidate["claim"];
}

export async function extractMemoryBatchCandidatesWithLlm(input: {
  sources: MemoryBatchExtractionSource[];
  workspaceSlug?: string;
  modelRef?: string;
  fallbackModelRefs?: string[];
  modelVisibleMessage?: string;
  existingMemories?: MemoryBatchExtractionExistingMemory[];
  maxRounds?: number;
  agentMode?: boolean;
  threadId?: string;
  runId?: string;
  createProvider?: MemoryExtractionProviderFactory;
}): Promise<MemoryBatchExtractionCandidate[]> {
  const sources = input.sources
    .map((source) => ({
      sourceId: source.sourceId,
      text: stripMemoryUserMessagePrefix(source.text).trim(),
      role: source.role ?? "user"
    }))
    .filter((source) => source.sourceId && source.text && !DO_NOT_REMEMBER_RE.test(source.text));
  if (sources.length === 0) return [];
  const explicitCandidates = extractExplicitBatchCandidates(
    sources.filter((source) => source.role === "user"),
    input.workspaceSlug
  );

  const config = getEffectiveLumeConfig(input.workspaceSlug);
  const modelRefs = resolveMemoryExtractionModelRefs(config, {
    modelRef: input.modelRef,
    fallbackModelRefs: input.fallbackModelRefs
  });
  if (modelRefs.length === 0) {
    return explicitCandidates;
  }

  for (const modelRef of modelRefs) {
    try {
      const parsed = await extractMemoryBatchCandidatesWithModel({
        sources,
        workspaceSlug: input.workspaceSlug,
        modelVisibleMessage: input.modelVisibleMessage,
        existingMemories: input.existingMemories,
        maxRounds: input.maxRounds,
        agentMode: input.agentMode,
        threadId: input.threadId,
        runId: input.runId,
        modelRef,
        createProvider: input.createProvider
      });
      if (parsed) return mergeBatchExtractionCandidates(parsed, explicitCandidates);
    } catch {
      continue;
    }
  }
  return explicitCandidates;
}

export function resolveMemoryExtractionModelRef(config: Pick<LumeEffectiveConfig, "memory">): string | undefined {
  const memory = isRecord(config.memory) ? config.memory : {};
  const extraction = isRecord(memory.extraction) ? memory.extraction : {};
  return normalizeOptionalString(extraction.modelRef)
    ?? normalizeOptionalString(memory.extractionModelRef);
}

export function resolveMemoryExtractionModelRefs(
  config: Pick<LumeEffectiveConfig, "memory" | "models">,
  input: { modelRef?: string; fallbackModelRefs?: string[] } = {}
): string[] {
  return uniqueModelRefs([
    input.modelRef,
    input.modelRef ? undefined : resolveMemoryExtractionModelRef(config),
    ...(input.fallbackModelRefs ?? []),
    ...(config.models?.agent?.fallbackModelRefs ?? [])
  ]);
}

async function extractMemoryCandidatesWithModel(input: {
  text: string;
  workspaceSlug?: string;
  modelRef: string;
  createProvider?: MemoryExtractionProviderFactory;
}): Promise<MemoryV2Candidate[] | undefined> {
  const binding = resolveChannelModelBinding(input.modelRef, "chat");
  if (!binding && !input.createProvider) return undefined;
  const provider = createMemoryExtractionProvider({
    modelRef: input.modelRef,
    binding,
    createProvider: input.createProvider
  });
  const response = await provider.createMessage({
    model: binding?.modelId ?? input.modelRef.split("/").at(-1) ?? input.modelRef,
    maxTokens: 700,
    system: buildExtractionSystemPrompt(),
    messages: [{
      role: "user",
      content: buildExtractionUserPrompt(input.text, input.workspaceSlug)
    }]
  });
  return parseLlmExtractionResponse(
    response.content
      .map((block) => block.type === "text" ? block.text : "")
      .filter(Boolean)
      .join("\n"),
    input.text
  ) ?? undefined;
}

async function extractMemoryBatchCandidatesWithModel(input: {
  sources: Array<{ sourceId: string; text: string; role: "user" | "assistant" | "tool_result" }>;
  workspaceSlug?: string;
  modelVisibleMessage?: string;
  existingMemories?: MemoryBatchExtractionExistingMemory[];
  maxRounds?: number;
  agentMode?: boolean;
  threadId?: string;
  runId?: string;
  modelRef: string;
  createProvider?: MemoryExtractionProviderFactory;
}): Promise<MemoryBatchExtractionCandidate[] | undefined> {
  const binding = resolveChannelModelBinding(input.modelRef, "chat");
  if (!binding && !input.createProvider) return undefined;
  const provider = createMemoryExtractionProvider({
    modelRef: input.modelRef,
    binding,
    createProvider: input.createProvider
  });
  const model = binding?.modelId ?? input.modelRef.split("/").at(-1) ?? input.modelRef;
  const maxRounds = normalizeExtractionRounds(input.maxRounds);
  const allCandidates: MemoryBatchExtractionCandidate[] = [];
  const memoryTools = input.agentMode ? await createBackgroundMemoryTools({
    workspaceSlug: input.workspaceSlug ?? "",
    threadId: input.threadId,
    runId: input.runId
  }) : [];
  const apiTools = memoryTools.map((tool) => toApiTool(tool));
  let messages: NormalizedMessageParam[] = [{
    role: "user",
    content: buildBatchExtractionUserPrompt(
      input.sources,
      input.workspaceSlug,
      input.modelVisibleMessage,
      input.existingMemories
    )
  }];

  for (let round = 0; round < maxRounds; round += 1) {
    const response = await provider.createMessage({
      model,
      maxTokens: 1200,
      system: buildBatchExtractionSystemPrompt(),
      messages,
      ...(apiTools.length > 0 ? { tools: apiTools } : {})
    });
    const toolUses = response.content.filter((block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use");
    if (toolUses.length > 0) {
      messages = [
        ...messages,
        {
          role: "assistant",
          content: response.content.filter((block) => block.type === "text" || block.type === "tool_use") as NormalizedContentBlock[]
        },
        {
          role: "user",
          content: await Promise.all(toolUses.map(async (toolUse) => {
            const tool = memoryTools.find((candidate) => candidate.name === toolUse.name);
            const result = tool
              ? await tool.call(toolUse.input, { cwd: process.cwd(), sessionId: input.threadId, runId: input.runId, toolUseId: toolUse.id })
              : { type: "tool_result" as const, tool_use_id: toolUse.id, content: `Unknown memory tool: ${toolUse.name}`, is_error: true };
            return {
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: result.content,
              ...(result.is_error ? { is_error: true } : {})
            };
          }))
        }
      ];
      continue;
    }
    const text = response.content
      .map((block) => block.type === "text" ? block.text : "")
      .filter(Boolean)
      .join("\n");
    const parsed = parseLlmBatchExtractionResponse(text, input.sources) ?? [];
    allCandidates.push(...parsed);
    const coveredSourceIds = new Set(allCandidates.map((candidate) => candidate.sourceId));
    if (parsed.length === 0 || coveredSourceIds.size >= input.sources.length || round === maxRounds - 1) break;

    const remainingSources = input.sources.filter((source) => !coveredSourceIds.has(source.sourceId));
    messages = [
      ...messages,
      { role: "assistant", content: text },
      {
        role: "user",
        content: buildBatchExtractionReviewPrompt(remainingSources, input.existingMemories, round + 2)
      }
    ];
  }

  return dedupeBatchExtractionCandidates(allCandidates);
}

async function createBackgroundMemoryTools(input: {
  workspaceSlug: string;
  threadId?: string;
  runId?: string;
}): Promise<ToolDefinition[]> {
  const { createSdkMemoryTools } = await import("../agent-runtime/tools/memory/create-memory-tools");
  return createSdkMemoryTools({
    workspaceSlug: input.workspaceSlug,
    enabledTools: new Set(["memory.search", "memory.read"]),
    includeCitations: false,
    threadId: input.threadId,
    runId: input.runId
  });
}

function normalizeExtractionRounds(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return 1;
  return Math.min(5, Math.max(1, Math.floor(value)));
}

function dedupeBatchExtractionCandidates(candidates: MemoryBatchExtractionCandidate[]): MemoryBatchExtractionCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.sourceId}\u0000${candidate.candidate.statement.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createMemoryExtractionProvider(input: {
  modelRef: string;
  binding: ReturnType<typeof resolveChannelModelBinding>;
  createProvider?: MemoryExtractionProviderFactory;
}): LLMProvider {
  if (!input.createProvider && input.binding) {
    return createLazyConnectionLlmProvider({
      connectionId: input.binding.channel.id,
      modelId: input.binding.modelId,
    });
  }
  return input.createProvider!({
    apiType: input.binding ? resolveExtractionApiType(input.binding.channel.provider) : "openai-completions",
    apiKey: input.binding ? decryptApiKey(input.binding.channel.id) : "",
    baseURL: input.binding?.channel.baseUrl
  });
}

function uniqueModelRefs(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || result.includes(trimmed)) continue;
    result.push(trimmed);
  }
  return result;
}

function extractStatement(text: string): string | undefined {
  const patterns = [
    /(?:^|\b)remember(?: that)?[:：]?\s+([\s\S]+)$/i,
    /(?:^|\b)please remember[:：]?\s+([\s\S]+)$/i,
    /记住[:：]?\s*([\s\S]+)$/i,
    /以后[:：]?\s*([\s\S]+)$/i,
    /(?:^|\b)i prefer\s+([\s\S]+)$/i,
    /(?:^|\b)prefer\s+([\s\S]+)$/i,
    /我(?:更)?(?:喜欢|偏好)\s*([\s\S]+)$/i,
    /(?:^|\b)actually[:：]?\s+([\s\S]+)$/i,
    /(?:不对|错了)[:：]?\s*([\s\S]+)$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return stripTrailingNoise(candidate);
  }
  return undefined;
}

function inferKind(text: string, statement: string): MemoryV2Candidate["kind"] {
  const combined = `${text}\n${statement}`.toLowerCase();
  if (/prefer|以后|喜欢|偏好|默认|习惯/.test(combined)) return "preference";
  if (/actually|不对|错了|correction|correct/.test(combined)) return "fact";
  return "fact";
}

function inferTags(text: string, statement = ""): string[] {
  const combined = `${text}\n${statement}`;
  const tags = ["explicit-intent"];
  if (/memory|记忆/.test(combined)) tags.push("memory");
  if (/workflow|commit|push|提交|推送/.test(combined)) tags.push("workflow");
  if (/写作风格|文风|语气|表达风格|措辞|行文|writing style|voice|tone/.test(combined)) {
    tags.push("voice", "writing-style");
  }
  return tags;
}

function inferEntities(text: string): string[] {
  const entities: string[] = [];
  if (/lume/i.test(text)) entities.push("Lume");
  return entities;
}

function stripTrailingNoise(value: string): string {
  return value
    .replace(/\s*(?:thanks|谢谢|。|！|!)+$/i, "")
    .trim();
}

function buildExtractionSystemPrompt(): string {
  return [
    "Gatekeeper task: decide whether a single user message contains durable memory worth extracting, then extract only verified candidates.",
    "Return only strict JSON with shape {\"shouldExtract\": boolean, \"candidates\": [...]}.",
    "Gate A: user profile or collaboration memory. True only for stable user preferences, identity/background, durable project facts, decisions, lessons, or current state that will matter later.",
    "Reject greetings, temporary tasks, one-off requests, assistant self-description, generic conversation, secrets, API keys, tokens, passwords, private keys, and anything the user says not to remember/save.",
    "Alice-style verification for each candidate:",
    "- source_found: sourceText must be an exact substring of the user message.",
    "- source_is_user: sourceRole must be \"user\".",
    "- system_prompt_overlap: reject assistant persona or system-instruction-like claims.",
    "Core principle: prefer false negatives; never invent or infer beyond the source text.",
    "Each candidate must be one short standalone claim.",
    "Use kind preference, fact, decision, lesson, or state.",
    "Use targetScope global for cross-workspace user preferences; use workspace for project facts, decisions, lessons, and state.",
    "Add claim when the memory can be represented as a stable fact edge: {subject, predicate, object}.",
    "Common claim examples:",
    "- \"叫我 Mason\" -> subject=user/self, predicate=preferred_name, object=Mason.",
    "- \"我叫 Mason\" -> subject=user/self, predicate=preferred_name, object=Mason.",
    "- \"就想叫你 Alice\" -> subject=assistant/self, predicate=preferred_name, object=Alice.",
    "- \"我的写作风格偏好简洁、有温度\" -> subject=user/self, predicate=writing_style, object=简洁、有温度.",
    "- \"Lume Memory V2 使用 Markdown 作为事实源\" -> subject=workspace/default, predicate=source_of_truth, object=Markdown.",
    "Do not use assistant/self claims to overwrite product/system identity; they are user-given naming preferences.",
    "Candidate fields: kind, targetScope, statement, confidence, sourceRole, sourceText, reason, tags, entities, claim."
  ].join("\n");
}

function buildExtractionUserPrompt(text: string, workspaceSlug?: string): string {
  return JSON.stringify({
    workspaceSlug: workspaceSlug ?? null,
    userMessage: text,
    output: {
      shouldExtract: true,
      candidates: [{
        kind: "preference|fact|decision|lesson|state",
        targetScope: "global|workspace",
        statement: "short standalone claim",
        confidence: "low|medium|high",
        sourceRole: "user",
        sourceText: "exact substring from userMessage",
        reason: "why this is durable",
        tags: ["optional"],
        entities: ["optional"],
        claim: {
          subject: "user/self|assistant/self|workspace/default|open string",
          predicate: "preferred_name|identity|preference|open string",
          object: "fact value"
        }
      }]
    }
  });
}

function buildBatchExtractionSystemPrompt(): string {
  return [
    "Gatekeeper task: decide whether a batch of external memory sources contains durable memory worth extracting.",
    "Return only strict JSON with shape {\"shouldExtract\": boolean, \"candidates\": [...]}.",
    "Each candidate must cite exactly one sourceId from the provided sources.",
    "sourceText must be an exact substring of that source's text.",
    "sourceRole must match the cited source's role. User messages are the primary authority; tool results may support verified project facts or decisions.",
    "Never create a candidate whose only evidence is an assistant message. Assistant messages may provide context but cannot establish a fact by themselves.",
    "Do not merge multiple sources into one fact unless the cited source itself contains the full fact.",
    "Use existingMemories as a read-only manifest: prefer the existing Claim when the new evidence confirms it, and avoid creating a duplicate statement.",
    "When memory.search or memory.read tools are available, use them only to verify or disambiguate existing memories; never use tools outside the memory namespace.",
    "Reject greetings, temporary tasks, secrets, API keys, tokens, passwords, private keys, and anything the user says not to remember/save.",
    "Prefer false negatives; never invent or infer beyond the cited source.",
    "Use kind preference, fact, decision, lesson, or state.",
    "Use targetScope global for cross-workspace user preferences; use workspace for project facts, decisions, lessons, and state.",
    "Add claim when the memory can be represented as a stable fact edge: {subject, predicate, object}.",
    "Use predicate writing_style for durable user writing voice, tone, wording, and prose-style preferences; tag them with voice and writing-style.",
    "Candidate fields: sourceId, kind, targetScope, statement, confidence, sourceRole, sourceText, reason, tags, entities, claim."
  ].join("\n");
}

function buildBatchExtractionUserPrompt(
  sources: MemoryBatchExtractionSource[],
  workspaceSlug?: string,
  modelVisibleMessage?: string,
  existingMemories?: MemoryBatchExtractionExistingMemory[]
): string {
  return JSON.stringify({
    workspaceSlug: workspaceSlug ?? null,
    modelVisibleMessage: modelVisibleMessage?.trim() || undefined,
    existingMemories: existingMemories?.slice(0, 200),
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      role: source.role ?? "user",
      text: source.text
    })),
    output: {
      shouldExtract: true,
      candidates: [{
        sourceId: "one sourceId from sources",
        sourceRole: "user|assistant|tool_result (must match the source)",
        kind: "preference|fact|decision|lesson|state",
        targetScope: "global|workspace",
        statement: "short standalone claim",
        confidence: "low|medium|high",
        sourceText: "exact substring from that source text",
        reason: "why this is durable",
        tags: ["optional"],
        entities: ["optional"],
        claim: {
          subject: "user/self|assistant/self|workspace/default|open string",
          predicate: "preferred_name|identity|preference|open string",
          object: "fact value"
        }
      }]
    }
  });
}

function buildBatchExtractionReviewPrompt(
  sources: MemoryBatchExtractionSource[],
  existingMemories: MemoryBatchExtractionExistingMemory[] | undefined,
  round: number
): string {
  return JSON.stringify({
    task: "Review only the remaining sources for durable memory candidates.",
    round,
    existingMemories: existingMemories?.slice(0, 200),
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      role: source.role ?? "user",
      text: source.text
    })),
    constraints: [
      "Cite exactly one provided sourceId.",
      "sourceText must be an exact substring of the cited source.",
      "Assistant-only evidence is forbidden.",
      "Return strict JSON with the same output shape as the first round.",
      "Return an empty candidate list when no durable memory is supported."
    ]
  });
}

function parseLlmExtractionResponse(text: string, userMessage: string): MemoryV2Candidate[] | null {
  const parsed = safeJsonParse(extractJsonObject(text));
  if (!isRecord(parsed) || typeof parsed.shouldExtract !== "boolean" || !Array.isArray(parsed.candidates)) return null;
  if (!parsed.shouldExtract) return [];
  const candidates: MemoryV2Candidate[] = [];
  for (const item of parsed.candidates) {
    if (!isRecord(item)) continue;
    const candidate = parseCandidateItem(item, userMessage);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function extractExplicitBatchCandidates(
  sources: MemoryBatchExtractionSource[],
  workspaceSlug?: string
): MemoryBatchExtractionCandidate[] {
  return sources.flatMap((source) =>
    extractExplicitMemoryCandidates({
      text: source.text,
      workspaceSlug
    }).map((candidate) => ({
      sourceId: source.sourceId,
      candidate
    }))
  );
}

function mergeBatchExtractionCandidates(
  parsed: MemoryBatchExtractionCandidate[],
  explicitCandidates: MemoryBatchExtractionCandidate[]
): MemoryBatchExtractionCandidate[] {
  if (parsed.length === 0) return explicitCandidates;
  const parsedKeys = new Set(parsed.map(batchCandidateKey));
  const missingExplicit = explicitCandidates.filter((item) => !parsedKeys.has(batchCandidateKey(item)));
  return [...parsed, ...missingExplicit];
}

function batchCandidateKey(item: MemoryBatchExtractionCandidate): string {
  const claim = item.candidate.claim;
  if (claim) {
    return [
      item.candidate.targetScope,
      claim.subject,
      claim.predicate,
      claim.object
    ].join("\u0000").toLowerCase();
  }
  return [
    item.candidate.targetScope,
    item.candidate.kind,
    item.candidate.statement
  ].join("\u0000").toLowerCase();
}

function parseLlmBatchExtractionResponse(
  text: string,
  sources: MemoryBatchExtractionSource[]
): MemoryBatchExtractionCandidate[] | null {
  const parsed = safeJsonParse(extractJsonObject(text));
  if (!isRecord(parsed) || typeof parsed.shouldExtract !== "boolean" || !Array.isArray(parsed.candidates)) return null;
  if (!parsed.shouldExtract) return [];
  const sourceById = new Map(sources.map((source) => [source.sourceId, {
    ...source,
    role: source.role ?? "user"
  }]));
  const candidates: MemoryBatchExtractionCandidate[] = [];
  for (const item of parsed.candidates) {
    if (!isRecord(item)) continue;
    const sourceId = normalizeOptionalString(item.sourceId);
    const sourceText = normalizeOptionalString(item.sourceText);
    const source = sourceId ? sourceById.get(sourceId) : undefined;
    if (!sourceId || !source || !sourceText || !source.text.includes(sourceText)) continue;
    const candidate = parseCandidateItem(item, source.text, source.role ?? "user");
    if (!candidate) continue;
    candidates.push({
      sourceId,
      candidate
    });
  }
  return candidates;
}

function parseCandidateItem(
  item: Record<string, unknown>,
  userMessage: string,
  expectedSourceRole: "user" | "assistant" | "tool_result" = "user"
): MemoryV2Candidate | undefined {
  const kind = normalizeKind(item.kind);
  const targetScope = item.targetScope === "global" || item.targetScope === "workspace"
    ? item.targetScope
    : undefined;
  const statement = normalizeOptionalString(item.statement);
  const sourceRole = item.sourceRole;
  const sourceText = normalizeOptionalString(item.sourceText);
  const confidence = item.confidence === "low" || item.confidence === "medium" || item.confidence === "high"
    ? item.confidence
    : "medium";
  if (!kind || !targetScope || !statement || DO_NOT_REMEMBER_RE.test(statement)) return undefined;
  if (sourceRole !== expectedSourceRole || expectedSourceRole === "assistant" || !sourceText || !userMessage.includes(sourceText)) return undefined;
  const tags = normalizeStringList(item.tags);
  return {
    kind,
    targetScope,
    statement,
    confidence,
    tags,
    entities: normalizeStringList(item.entities),
    claim: normalizeMemoryV2Claim(item.claim) ?? inferMemoryV2Claim({ statement, tags }),
    evidence: {
      quote: sourceText
    }
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match?.[0] ?? "";
}

function safeJsonParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeKind(value: unknown): MemoryV2Candidate["kind"] | undefined {
  if (
    value === "preference"
    || value === "fact"
    || value === "decision"
    || value === "lesson"
    || value === "state"
  ) {
    return value;
  }
  return undefined;
}

function resolveExtractionApiType(provider: string): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") return "anthropic-messages";
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}
