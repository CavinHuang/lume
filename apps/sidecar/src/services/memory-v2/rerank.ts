import { createProvider, type ApiType, type LLMProvider } from "@lume/agent-sdk";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { resolveMemoryExtractionModelRef } from "./extraction";
import type { MemoryV2RecallItem } from "./types";

export type MemoryV2RerankItems = (
  items: MemoryV2RecallItem[],
  query: string
) => Promise<MemoryV2RecallItem[]>;

type RerankProviderFactory = (input: {
  apiType: ApiType;
  apiKey: string;
  baseURL?: string;
}) => LLMProvider;

export function resolveMemoryRerankModelRef(input: {
  workspaceSlug?: string;
  explicitModelRef?: string;
}): { modelRef?: string; source: "explicit" | "extraction" | "disabled" } {
  const explicit = input.explicitModelRef?.trim();
  if (explicit) return { modelRef: explicit, source: "explicit" };
  const extraction = resolveMemoryExtractionModelRef(getEffectiveLumeConfig(input.workspaceSlug));
  return extraction
    ? { modelRef: extraction, source: "extraction" }
    : { source: "disabled" };
}

export function createMemoryV2Reranker(input: {
  workspaceSlug?: string;
  modelRef?: string;
  createProvider?: RerankProviderFactory;
}): MemoryV2RerankItems | undefined {
  const resolved = resolveMemoryRerankModelRef({
    workspaceSlug: input.workspaceSlug,
    explicitModelRef: input.modelRef
  });
  if (!resolved.modelRef) return undefined;
  const binding = resolveChannelModelBinding(resolved.modelRef, "chat");
  if (!binding && !input.createProvider) return undefined;
  const providerFactory = input.createProvider ?? ((options) => createProvider(options.apiType, {
    apiKey: options.apiKey,
    baseURL: options.baseURL
  }));
  const provider = providerFactory({
    apiType: binding ? resolveRerankApiType(binding.channel.provider) : "openai-completions",
    apiKey: binding ? decryptApiKey(binding.channel.id) : "",
    baseURL: binding?.channel.baseUrl
  });
  const model = binding?.modelId ?? resolved.modelRef.split("/").at(-1) ?? resolved.modelRef;
  return async (items, query) => rerankWithLlm({ provider, model, items, query });
}

async function rerankWithLlm(input: {
  provider: LLMProvider;
  model: string;
  items: MemoryV2RecallItem[];
  query: string;
}): Promise<MemoryV2RecallItem[]> {
  if (input.items.length <= 1) return input.items;
  const response = await input.provider.createMessage({
    model: input.model,
    maxTokens: 500,
    system: [
      "Rank memory candidates for relevance to the user query.",
      "Return strict JSON only: {\"ids\":[\"candidate-id\", ...]}.",
      "Do not create facts. Only reorder ids already provided."
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({
        query: input.query,
        candidates: input.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          scope: item.scope,
          statement: item.statement
        }))
      })
    }]
  });
  const text = response.content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
  const ids = parseIds(text);
  if (ids.length === 0) return input.items;
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const ranked = ids.map((id) => byId.get(id)).filter((item): item is MemoryV2RecallItem => Boolean(item));
  const used = new Set(ranked.map((item) => item.id));
  return [...ranked, ...input.items.filter((item) => !used.has(item.id))];
}

function parseIds(text: string): string[] {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { ids?: unknown };
    return Array.isArray(parsed.ids)
      ? parsed.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function resolveRerankApiType(provider: string): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") return "anthropic-messages";
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}
