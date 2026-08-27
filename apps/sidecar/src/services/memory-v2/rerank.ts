import { type ApiType, type LLMProvider } from "@lume/agent-sdk";
import { resolveProviderApiType } from "../model-runtime/provider-api-type";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { resolveChatProvider } from "./chat-provider";
import { resolveMemoryExtractionModelRef, resolveMemoryExtractionModelRefs } from "./extraction";
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

export function resolveMemoryRerankModelRefs(input: {
  workspaceSlug?: string;
  explicitModelRef?: string;
  fallbackModelRefs?: string[];
}): string[] {
  const resolved = resolveMemoryRerankModelRef({
    workspaceSlug: input.workspaceSlug,
    explicitModelRef: input.explicitModelRef
  });
  if (!resolved.modelRef) return [];
  return resolveMemoryExtractionModelRefs(getEffectiveLumeConfig(input.workspaceSlug), {
    modelRef: resolved.modelRef,
    fallbackModelRefs: input.fallbackModelRefs
  });
}

export function createMemoryV2Reranker(input: {
  workspaceSlug?: string;
  modelRef?: string;
  fallbackModelRefs?: string[];
  createProvider?: RerankProviderFactory;
}): MemoryV2RerankItems | undefined {
  const modelRefs = resolveMemoryRerankModelRefs({
    workspaceSlug: input.workspaceSlug,
    explicitModelRef: input.modelRef,
    fallbackModelRefs: input.fallbackModelRefs
  });
  if (modelRefs.length === 0) return undefined;
  return async (items, query) => {
    for (const modelRef of modelRefs) {
      try {
        const attempt = createRerankAttempt(modelRef, input.createProvider);
        if (!attempt) continue;
        return await rerankWithLlm({ ...attempt, items, query });
      } catch {
        continue;
      }
    }
    return items;
  };
}

function createRerankAttempt(
  modelRef: string,
  createProviderInput?: RerankProviderFactory
): { provider: LLMProvider; model: string } | undefined {
  const binding = resolveChannelModelBinding(modelRef, "chat");
  if (!binding && !createProviderInput) return undefined;
  return {
    provider: createProviderInput
      ? createProviderInput({
        apiType: binding ? resolveProviderApiType({ provider: binding.channel.provider }) : "openai-completions",
        apiKey: binding ? decryptApiKey(binding.channel.id) : "",
        baseURL: binding?.channel.baseUrl
      })
      : resolveChatProvider(modelRef).provider,
    model: binding?.modelId ?? modelRef.split("/").at(-1) ?? modelRef
  };
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
    // 输出是全部候选 id 的 JSON 回显:上限必须随候选池规模缩放(#521 候选池
    // 放宽后 48 条 × 每条 ~25 token 会击穿固定 500 导致恒等回退)
    maxTokens: Math.max(500, input.items.length * 80),
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

