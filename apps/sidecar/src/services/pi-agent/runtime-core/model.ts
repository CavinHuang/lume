import { getModel, type KnownProvider, type Model, type Api } from "@mariozechner/pi-ai";
import { resolveModelCandidatesForChannel } from "../../model-selection";
import { adaptModelCapabilities, resolveAgentThinkingLevel } from "../runner/model-capabilities";
import { prioritizeProvidersForBaseUrl, shouldApplyChannelBaseUrl } from "../runner/provider-routing";
import { resolvePiProviderCandidates } from "../runner/provider-resolution";

export interface ResolveRuntimeCoreModelInput {
  provider: KnownProvider;
  modelId: string;
}

export interface ResolvedPiChannelModel {
  provider: KnownProvider;
  resolvedModelId: string;
  model: Model<Api>;
}

export function resolveRuntimeCoreModel(
  input: ResolveRuntimeCoreModelInput
): Model<Api> | undefined {
  return getModel(input.provider, input.modelId as never);
}

export function resolvePiChannelModel(params: {
  channel: {
    models: Array<{ id: string; enabled: boolean; alias?: string; name: string }>;
    defaultModelId?: string;
    fallbackModelIds?: string[];
  };
  channelProvider?: string;
  modelId: string;
  baseUrl?: string;
}): ResolvedPiChannelModel | null {
  const candidateModelIds = resolveModelCandidatesForChannel(params.channel, params.modelId);
  for (const candidateModelId of candidateModelIds) {
    const { modelId, candidates } = resolvePiProviderCandidates({
      channelProvider: params.channelProvider,
      modelId: candidateModelId,
      baseUrl: params.baseUrl
    });
    for (const provider of prioritizeProvidersForBaseUrl(candidates, params.baseUrl)) {
      const catalogModel = getModel(provider, modelId as never);
      if (catalogModel) {
        return {
          provider,
          resolvedModelId: modelId,
          model: applyChannelBaseUrl(
            catalogModel,
            shouldApplyChannelBaseUrl(provider, params.baseUrl) ? params.baseUrl : undefined
          )
        };
      }
    }
  }

  const firstModelId = candidateModelIds[0]?.trim();
  if (!firstModelId) {
    return null;
  }
  const { modelId, candidates } = resolvePiProviderCandidates({
    channelProvider: params.channelProvider,
    modelId: firstModelId,
    baseUrl: params.baseUrl
  });
  const fallbackProvider = candidates[0];
  if (!fallbackProvider) {
    return null;
  }
  return {
    provider: fallbackProvider,
    resolvedModelId: modelId,
    model: createFallbackModel(
      fallbackProvider,
      modelId,
      shouldApplyChannelBaseUrl(fallbackProvider, params.baseUrl) ? params.baseUrl : undefined
    )
  };
}

export const resolveRuntimeCoreChannelModel = resolvePiChannelModel;

function applyChannelBaseUrl(model: Model<Api>, baseUrl?: string): Model<Api> {
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedBaseUrl) {
    return adaptModelCapabilities(model);
  }
  return adaptModelCapabilities({
    ...model,
    baseUrl: trimmedBaseUrl
  }, trimmedBaseUrl);
}

function createFallbackModel(provider: KnownProvider, modelId: string, baseUrl?: string): Model<Api> {
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
    reasoning: supportsReasoning(provider, normalizedBaseUrl),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
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

function supportsReasoning(provider: KnownProvider, baseUrl?: string): boolean {
  if (provider !== "anthropic") {
    return true;
  }
  return resolveAgentThinkingLevel({
    id: "tmp",
    name: "tmp",
    provider,
    api: "anthropic-messages",
    reasoning: true
  } as Model<Api>, baseUrl) !== undefined;
}
