import { createProvider, type ApiType, type LLMProvider } from "@lume/agent-sdk";
import type { LumeEffectiveConfig } from "@lume/shared";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
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
    tags: inferTags(text),
    entities: inferEntities(text),
    claim: inferMemoryV2Claim({ statement, tags: inferTags(text) }),
    appliesWhen: targetScope === "workspace" && input.workspaceSlug
      ? { workspaceSlug: input.workspaceSlug }
      : {},
    evidence: {
      quote: text
    }
  }];
}

export async function extractMemoryCandidatesWithLlm(input: {
  text: string;
  workspaceSlug?: string;
  modelRef?: string;
  createProvider?: MemoryExtractionProviderFactory;
}): Promise<MemoryV2Candidate[]> {
  const text = stripMemoryUserMessagePrefix(input.text).trim();
  if (!text || DO_NOT_REMEMBER_RE.test(text)) return [];
  const modelRef = input.modelRef ?? resolveMemoryExtractionModelRef(getEffectiveLumeConfig(input.workspaceSlug));
  if (!modelRef) {
    return extractExplicitMemoryCandidates(input);
  }

  try {
    const binding = resolveChannelModelBinding(modelRef, "chat");
    if (!binding && !input.createProvider) {
      return extractExplicitMemoryCandidates(input);
    }
    const providerFactory = input.createProvider ?? ((options) => createProvider(options.apiType, {
      apiKey: options.apiKey,
      baseURL: options.baseURL
    }));
    const provider = providerFactory({
      apiType: binding ? resolveExtractionApiType(binding.channel.provider) : "openai-completions",
      apiKey: binding ? decryptApiKey(binding.channel.id) : "",
      baseURL: binding?.channel.baseUrl
    });
    const response = await provider.createMessage({
      model: binding?.modelId ?? modelRef.split("/").at(-1) ?? modelRef,
      maxTokens: 700,
      system: buildExtractionSystemPrompt(),
      messages: [{
        role: "user",
        content: buildExtractionUserPrompt(text, input.workspaceSlug)
      }]
    });
    const parsed = parseLlmExtractionResponse(
      response.content
        .map((block) => block.type === "text" ? block.text : "")
        .filter(Boolean)
        .join("\n"),
      text
    );
    return parsed ?? extractExplicitMemoryCandidates(input);
  } catch {
    return extractExplicitMemoryCandidates(input);
  }
}

export interface MemoryBatchExtractionSource {
  sourceId: string;
  text: string;
}

export interface MemoryBatchExtractionCandidate {
  sourceId: string;
  candidate: MemoryV2Candidate;
}

export async function extractMemoryBatchCandidatesWithLlm(input: {
  sources: MemoryBatchExtractionSource[];
  workspaceSlug?: string;
  modelRef?: string;
  createProvider?: MemoryExtractionProviderFactory;
}): Promise<MemoryBatchExtractionCandidate[]> {
  const sources = input.sources
    .map((source) => ({
      sourceId: source.sourceId,
      text: stripMemoryUserMessagePrefix(source.text).trim()
    }))
    .filter((source) => source.sourceId && source.text && !DO_NOT_REMEMBER_RE.test(source.text));
  if (sources.length === 0) return [];

  const modelRef = input.modelRef ?? resolveMemoryExtractionModelRef(getEffectiveLumeConfig(input.workspaceSlug));
  if (!modelRef) {
    return extractExplicitBatchCandidates(sources, input.workspaceSlug);
  }

  try {
    const binding = resolveChannelModelBinding(modelRef, "chat");
    if (!binding && !input.createProvider) {
      return extractExplicitBatchCandidates(sources, input.workspaceSlug);
    }
    const providerFactory = input.createProvider ?? ((options) => createProvider(options.apiType, {
      apiKey: options.apiKey,
      baseURL: options.baseURL
    }));
    const provider = providerFactory({
      apiType: binding ? resolveExtractionApiType(binding.channel.provider) : "openai-completions",
      apiKey: binding ? decryptApiKey(binding.channel.id) : "",
      baseURL: binding?.channel.baseUrl
    });
    const response = await provider.createMessage({
      model: binding?.modelId ?? modelRef.split("/").at(-1) ?? modelRef,
      maxTokens: 1200,
      system: buildBatchExtractionSystemPrompt(),
      messages: [{
        role: "user",
        content: buildBatchExtractionUserPrompt(sources, input.workspaceSlug)
      }]
    });
    const parsed = parseLlmBatchExtractionResponse(
      response.content
        .map((block) => block.type === "text" ? block.text : "")
        .filter(Boolean)
        .join("\n"),
      sources
    );
    return parsed ?? extractExplicitBatchCandidates(sources, input.workspaceSlug);
  } catch {
    return extractExplicitBatchCandidates(sources, input.workspaceSlug);
  }
}

export function resolveMemoryExtractionModelRef(config: Pick<LumeEffectiveConfig, "memory">): string | undefined {
  const memory = isRecord(config.memory) ? config.memory : {};
  const extraction = isRecord(memory.extraction) ? memory.extraction : {};
  return normalizeOptionalString(extraction.modelRef)
    ?? normalizeOptionalString(memory.extractionModelRef);
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

function inferTags(text: string): string[] {
  const tags = ["explicit-intent"];
  if (/memory|记忆/.test(text)) tags.push("memory");
  if (/workflow|commit|push|提交|推送/.test(text)) tags.push("workflow");
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
    "Reject candidates without a valid sourceId, without exact sourceText, or with sourceRole other than \"user\".",
    "Do not merge multiple sources into one fact unless the cited source itself contains the full fact.",
    "Reject greetings, temporary tasks, secrets, API keys, tokens, passwords, private keys, and anything the user says not to remember/save.",
    "Prefer false negatives; never invent or infer beyond the cited source.",
    "Use kind preference, fact, decision, lesson, or state.",
    "Use targetScope global for cross-workspace user preferences; use workspace for project facts, decisions, lessons, and state.",
    "Add claim when the memory can be represented as a stable fact edge: {subject, predicate, object}.",
    "Candidate fields: sourceId, kind, targetScope, statement, confidence, sourceRole, sourceText, reason, tags, entities, claim."
  ].join("\n");
}

function buildBatchExtractionUserPrompt(
  sources: MemoryBatchExtractionSource[],
  workspaceSlug?: string
): string {
  return JSON.stringify({
    workspaceSlug: workspaceSlug ?? null,
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      text: source.text
    })),
    output: {
      shouldExtract: true,
      candidates: [{
        sourceId: "one sourceId from sources",
        kind: "preference|fact|decision|lesson|state",
        targetScope: "global|workspace",
        statement: "short standalone claim",
        confidence: "low|medium|high",
        sourceRole: "user",
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

function parseLlmBatchExtractionResponse(
  text: string,
  sources: MemoryBatchExtractionSource[]
): MemoryBatchExtractionCandidate[] | null {
  const parsed = safeJsonParse(extractJsonObject(text));
  if (!isRecord(parsed) || typeof parsed.shouldExtract !== "boolean" || !Array.isArray(parsed.candidates)) return null;
  if (!parsed.shouldExtract) return [];
  const sourceById = new Map(sources.map((source) => [source.sourceId, source.text]));
  const candidates: MemoryBatchExtractionCandidate[] = [];
  for (const item of parsed.candidates) {
    if (!isRecord(item)) continue;
    const sourceId = normalizeOptionalString(item.sourceId);
    const sourceText = normalizeOptionalString(item.sourceText);
    const sourceBody = sourceId ? sourceById.get(sourceId) : undefined;
    if (!sourceId || !sourceBody || !sourceText || !sourceBody.includes(sourceText)) continue;
    const candidate = parseCandidateItem(item, sourceBody);
    if (!candidate) continue;
    candidates.push({
      sourceId,
      candidate
    });
  }
  return candidates;
}

function parseCandidateItem(item: Record<string, unknown>, userMessage: string): MemoryV2Candidate | undefined {
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
  if (sourceRole !== "user" || !sourceText || !userMessage.includes(sourceText)) return undefined;
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
