import { createProvider, type ApiType, type LLMProvider } from "@lume/agent-sdk";
import type { LumeEffectiveConfig } from "@lume/shared";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import type { MemoryV2Candidate } from "./types";

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
  const text = input.text.trim();
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
        .join("\n")
    );
    return parsed.length > 0 ? parsed : extractExplicitMemoryCandidates(input);
  } catch {
    return extractExplicitMemoryCandidates(input);
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
    "You extract durable memory candidates from a single user message.",
    "Return only strict JSON with shape {\"candidates\": [...]}.",
    "Only include durable, future-useful memory. Prefer false negatives.",
    "Never include secrets, API keys, tokens, passwords, or private keys.",
    "If the user says not to remember/save something, return {\"candidates\": []}.",
    "Each candidate must be one claim and use kind preference, fact, decision, lesson, or state.",
    "Use targetScope global for cross-workspace user preferences; use workspace for project facts, decisions, lessons, and state."
  ].join("\n");
}

function buildExtractionUserPrompt(text: string, workspaceSlug?: string): string {
  return JSON.stringify({
    workspaceSlug: workspaceSlug ?? null,
    userMessage: text,
    output: {
      candidates: [{
        kind: "preference|fact|decision|lesson|state",
        targetScope: "global|workspace",
        statement: "short standalone claim",
        confidence: "low|medium|high",
        tags: ["optional"],
        entities: ["optional"]
      }]
    }
  });
}

function parseLlmExtractionResponse(text: string): MemoryV2Candidate[] {
  const parsed = safeJsonParse(extractJsonObject(text));
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) return [];
  const candidates: MemoryV2Candidate[] = [];
  for (const item of parsed.candidates) {
    if (!isRecord(item)) continue;
    const kind = normalizeKind(item.kind);
    const targetScope = item.targetScope === "global" || item.targetScope === "workspace"
      ? item.targetScope
      : undefined;
    const statement = normalizeOptionalString(item.statement);
    const confidence = item.confidence === "low" || item.confidence === "medium" || item.confidence === "high"
      ? item.confidence
      : "medium";
    if (!kind || !targetScope || !statement || DO_NOT_REMEMBER_RE.test(statement)) continue;
    candidates.push({
      kind,
      targetScope,
      statement,
      confidence,
      tags: normalizeStringList(item.tags),
      entities: normalizeStringList(item.entities)
    });
  }
  return candidates;
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
