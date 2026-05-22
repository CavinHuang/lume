import { fetchWithProxy } from "../infra/proxy-fetch";
import { resolveChannelEmbeddingBinding } from "../channel/channel-manager";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import type { LumeEffectiveConfig } from "@lume/shared";

export type MemoryV2EmbedTexts = (texts: string[]) => Promise<number[][]>;

export function resolveMemoryEmbeddingModelRef(config: Pick<LumeEffectiveConfig, "models">): string | undefined {
  const modelRef = config.models?.embedding?.defaultModelRef?.trim();
  return modelRef || undefined;
}

export function createMemoryV2EmbeddingProvider(workspaceSlug?: string): MemoryV2EmbedTexts | undefined {
  const modelRef = resolveMemoryEmbeddingModelRef(getEffectiveLumeConfig(workspaceSlug));
  if (!modelRef) return undefined;
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
      Authorization: `Bearer ${input.apiKey}`
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

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
