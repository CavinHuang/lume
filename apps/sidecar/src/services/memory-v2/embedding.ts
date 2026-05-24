import { fetchWithProxy } from "../infra/proxy-fetch";
import { resolveChannelEmbeddingBinding } from "../channel/channel-manager";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { createLocalOnnxMemoryEmbeddingProvider } from "./local-embedding";
import type { LumeEffectiveConfig } from "@lume/shared";
import { MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF } from "@lume/shared";

export type MemoryV2EmbedTexts = (texts: string[]) => Promise<number[][]>;

export const LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF = MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF;

export interface MemoryV2EmbeddingAttempt {
  modelKey: string;
  embedTexts: MemoryV2EmbedTexts;
}

export function resolveMemoryEmbeddingModelRef(config: Pick<LumeEffectiveConfig, "models">): string | undefined {
  const modelRef = config.models?.embedding?.defaultModelRef?.trim();
  return modelRef || undefined;
}

export function createMemoryV2EmbeddingProvider(
  workspaceSlug?: string,
  options?: { includeImplicitLocal?: boolean }
): MemoryV2EmbedTexts | undefined {
  return createMemoryV2EmbeddingProviderFromAttempts(createMemoryV2EmbeddingAttempts(workspaceSlug, options));
}

export function createMemoryV2EmbeddingAttempts(
  workspaceSlug?: string,
  options?: { includeImplicitLocal?: boolean }
): MemoryV2EmbeddingAttempt[] {
  const configuredModelRef = resolveMemoryEmbeddingModelRef(getEffectiveLumeConfig(workspaceSlug));
  return resolveMemoryEmbeddingAttempts({
    configuredModelRef,
    remote: configuredModelRef && !isLocalOnnxMemoryEmbeddingModelRef(configuredModelRef)
      ? createRemoteMemoryV2EmbeddingProvider(configuredModelRef)
      : undefined,
    local: configuredModelRef || options?.includeImplicitLocal !== false
      ? createLocalOnnxMemoryEmbeddingProvider()
      : undefined
  });
}

export function resolveMemoryEmbeddingAttempts(input: {
  configuredModelRef?: string;
  remote?: MemoryV2EmbedTexts;
  local?: MemoryV2EmbedTexts;
}): MemoryV2EmbeddingAttempt[] {
  if (isLocalOnnxMemoryEmbeddingModelRef(input.configuredModelRef)) {
    return input.local
      ? [{ modelKey: LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF, embedTexts: input.local }]
      : [];
  }
  const attempts: MemoryV2EmbeddingAttempt[] = [];
  if (input.configuredModelRef && input.remote) {
    attempts.push({
      modelKey: input.configuredModelRef,
      embedTexts: input.remote
    });
  }
  if (input.local) {
    attempts.push({
      modelKey: LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF,
      embedTexts: input.local
    });
  }
  return attempts;
}

export function createMemoryV2EmbeddingProviderFromAttempts(
  attempts: MemoryV2EmbeddingAttempt[]
): MemoryV2EmbedTexts | undefined {
  const available = attempts.filter((attempt) => attempt.embedTexts);
  if (available.length === 0) return undefined;
  return async (texts) => {
    let lastError: unknown;
    for (const attempt of available) {
      try {
        return await attempt.embedTexts(texts);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Embedding unavailable."));
  };
}

export function resolveMemoryEmbeddingStatusModelRef(config: Pick<LumeEffectiveConfig, "models">): string | undefined {
  return resolveMemoryEmbeddingModelRef(config) ?? LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF;
}

function isLocalOnnxMemoryEmbeddingModelRef(modelRef?: string): boolean {
  return modelRef?.trim() === LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF;
}

function createRemoteMemoryV2EmbeddingProvider(modelRef: string): MemoryV2EmbedTexts | undefined {
  const binding = resolveChannelEmbeddingBinding(modelRef);
  if (!binding) return undefined;
  return (texts) => embedTexts({
    texts,
    baseUrl: binding.channel.baseUrl,
    apiKey: binding.apiKey,
    model: binding.modelId,
    family: binding.family
  });
}

async function embedTexts(input: {
  texts: string[];
  baseUrl: string;
  apiKey: string;
  model: string;
  family: "openai" | "google" | "anthropic";
}): Promise<number[][]> {
  if (input.family === "google") {
    const vectors: number[][] = [];
    for (const text of input.texts) {
      vectors.push(await embedGoogleText({ ...input, text }));
    }
    return vectors;
  }
  if (input.family === "anthropic") {
    throw new Error("Anthropic embedding is not supported.");
  }
  return embedOpenAITexts(input);
}

async function embedOpenAITexts(input: {
  texts: string[];
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<number[][]> {
  const response = await fetchWithProxy(`${normalizeBaseUrl(input.baseUrl)}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeaders(input.apiKey)
    },
    body: JSON.stringify({
      model: input.model,
      input: input.texts
    })
  });
  if (!response.ok) {
    throw new Error(`Embedding request failed (${response.status})`);
  }
  const json = await response.json() as { data?: Array<{ embedding?: unknown }> };
  const vectors = json.data?.map((item) => Array.isArray(item.embedding) ? item.embedding.filter(isNumber) : []) ?? [];
  if (vectors.length !== input.texts.length || vectors.some((vector) => vector.length === 0)) {
    throw new Error("Embedding response shape is invalid.");
  }
  return vectors;
}

async function embedGoogleText(input: {
  text: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<number[]> {
  const model = encodeURIComponent(input.model);
  const response = await fetchWithProxy(`${normalizeBaseUrl(input.baseUrl)}/v1beta/models/${model}:embedContent?key=${input.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: {
        parts: [{ text: input.text }]
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Embedding request failed (${response.status})`);
  }
  const json = await response.json() as { embedding?: { values?: unknown } };
  const vector = Array.isArray(json.embedding?.values) ? json.embedding.values.filter(isNumber) : [];
  if (vector.length === 0) throw new Error("Embedding response shape is invalid.");
  return vector;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
