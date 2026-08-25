import type { Api, KnownProvider, Model } from "./model-types";
import { findModelMeta } from "@lume/shared";
import { resolveModelCandidatesForChannel } from "./model-candidates";
import { prioritizeProvidersForBaseUrl, shouldApplyChannelBaseUrl } from "./provider-routing";
import { resolveRuntimeProviderCandidates } from "./provider-resolution";

export interface ResolvedPiChannelModel {
  provider: KnownProvider;
  resolvedModelId: string;
  model: Model<Api>;
}

export function resolvePiChannelModel(params: {
  channel: {
    models: Array<{ id: string; enabled: boolean; alias?: string; name: string; capabilities?: { vision?: boolean } }>;
    defaultModelId?: string;
    fallbackModelIds?: string[];
  };
  channelProvider?: string;
  requestedModelRefOrId: string;
  baseUrl?: string;
  contextWindowOverrides?: Record<string, number>;
}): ResolvedPiChannelModel | null {
  const candidateModelIds = resolveModelCandidatesForChannel(params.channel, params.requestedModelRefOrId);
  for (const candidateModelId of candidateModelIds) {
    const runtimeModelId = stripMatchingChannelProviderPrefix(candidateModelId, params.channelProvider);
    const { modelId, candidates } = resolveRuntimeProviderCandidates({
      channelProvider: params.channelProvider,
      modelId: runtimeModelId,
      baseUrl: params.baseUrl,
      modelIdIsOpaque: true,
    });
    for (const provider of prioritizeProvidersForBaseUrl(candidates, params.baseUrl)) {
      const channelModel = params.channel.models.find((item) => item.id === candidateModelId || item.alias === candidateModelId);
      return {
        provider,
        resolvedModelId: modelId,
        model: createFallbackModel(
          provider,
          modelId,
          shouldApplyChannelBaseUrl(provider, params.baseUrl) ? params.baseUrl : undefined,
          channelModel?.capabilities?.vision ?? findModelMeta(modelId)?.capabilities.vision,
          resolveContextWindowOverride(params, provider, modelId)
        )
      };
    }
  }

  // resolveRuntimeProviderCandidates 恒含 "openai" 兜底候选，上方循环首轮必命中；
  // 走到这里只可能是无任何候选模型 id。
  return null;
}

function stripMatchingChannelProviderPrefix(modelId: string, channelProvider?: string): string {
  const provider = channelProvider?.trim().toLowerCase();
  const separator = modelId.indexOf("/");
  if (!provider || separator <= 0 || modelId.slice(0, separator).trim().toLowerCase() !== provider) {
    return modelId;
  }
  return modelId.slice(separator + 1).trim() || modelId;
}

export const resolveRuntimeCoreChannelModel = resolvePiChannelModel;

function resolveContextWindowOverride(
  params: { requestedModelRefOrId: string; contextWindowOverrides?: Record<string, number> },
  provider: KnownProvider,
  modelId: string,
): number | undefined {
  const overrides = params.contextWindowOverrides
  if (!overrides) return undefined
  return overrides[params.requestedModelRefOrId]
    ?? overrides[`${provider}/${modelId}`]
    ?? overrides[modelId]
}

function createFallbackModel(
  provider: KnownProvider,
  modelId: string,
  baseUrl?: string,
  vision = false,
  contextWindowOverride?: number,
): Model<Api> {
  const normalizedBaseUrl = baseUrl?.trim() || resolveFallbackBaseUrl(provider);
  const api =
    provider === "anthropic"
      ? "anthropic-messages"
      : provider === "google"
        ? "google-generative-ai"
        : "openai-responses";
  return {
    id: modelId,
    name: modelId,
    provider,
    api,
    baseUrl: normalizedBaseUrl,
    reasoning: true,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowOverride ?? findModelMeta(modelId)?.contextWindow ?? 200000,
    maxTokens: 32768
  };
}

function resolveFallbackBaseUrl(provider: KnownProvider): string {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "google":
      return "https://generativelanguage.googleapis.com";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "zai":
      return "https://open.bigmodel.cn/api/paas/v4";
    case "minimax":
    case "minimax-cn":
      return "https://api.minimax.chat/v1";
    case "kimi-coding":
      return "https://api.moonshot.cn/v1";
    default:
      return "https://api.openai.com/v1";
  }
}
