import type { Channel, LumeConfigAgentDefaultStrategy, ProviderType } from "@lume/shared";

export interface ModelRef {
  provider: string;
  model: string;
}

export type AgentDefaultStrategySource = "thread-override" | "global-default" | "empty";

export interface ResolvedAgentDefaultStrategy {
  source: AgentDefaultStrategySource;
  channelId?: string;
  modelRef?: string;
  fallbackModelRefs: string[];
}

const PROVIDER_ALIAS: Record<string, string> = {
  "z.ai": "zai",
  "z-ai": "zai",
  zhipu: "zai",
  qwen: "qwen-portal",
  "kimi-code": "kimi-coding"
};

export function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_ALIAS[normalized] ?? normalized;
}

export function parseModelRef(raw: string, defaultProvider: string): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) {
    return {
      provider: normalizeProviderId(defaultProvider),
      model: trimmed
    };
  }
  const provider = normalizeProviderId(trimmed.slice(0, slashIndex));
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

type ProviderApiFamily = "anthropic" | "google" | "openai";

function resolveProviderApiFamilyFromBaseUrl(baseUrl: string): ProviderApiFamily | null {
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  if (!normalizedBaseUrl) return null;
  if (normalizedBaseUrl.includes("/anthropic")) return "anthropic";
  if (normalizedBaseUrl.includes("api.anthropic.com")) return "anthropic";
  if (normalizedBaseUrl.includes("generativelanguage.googleapis.com")) return "google";
  return "openai";
}

function resolveProviderApiFamilyFromId(provider: string): ProviderApiFamily {
  if (provider === "anthropic" || provider === "anthropic-compatible") return "anthropic";
  if (provider === "google" || provider === "gemini") return "google";
  return "openai";
}

function resolveAdapterProviderByFamily(family: ProviderApiFamily): ProviderType {
  if (family === "anthropic") return "anthropic";
  if (family === "google") return "google";
  return "openai";
}

function resolveOpenAICompatibleAdapterProvider(provider: string): ProviderType {
  const knownProvider = coerceKnownProvider(provider);
  return knownProvider === "deepseek" ? "deepseek" : "openai";
}

function coerceKnownProvider(provider: string): ProviderType {
  return ([
    "anthropic",
    "anthropic-compatible",
    "openai",
    "jina",
    "siliconflow",
    "openrouter",
    "deepseek",
    "google",
    "zai",
    "zai-coding-plan",
    "moonshot",
    "minimax",
    "minimax-cn",
    "doubao",
    "qwen",
    "qwen-portal",
    "kimi-coding",
    "opencode",
    "custom"
  ] as const).includes(provider as ProviderType)
    ? (provider as ProviderType)
    : "custom";
}

export function resolveChannelModelSelection(input: {
  channelProvider: ProviderType;
  baseUrl: string;
  modelId: string;
}): {
  adapterProvider: ProviderType;
  resolvedModelId: string;
  modelRef: string;
} {
  const parsed = parseModelRef(input.modelId, input.channelProvider);
  if (!parsed) {
    return {
      adapterProvider: input.channelProvider,
      resolvedModelId: input.modelId,
      modelRef: `${input.channelProvider}/${input.modelId}`
    };
  }

  const baseUrlFamily = resolveProviderApiFamilyFromBaseUrl(input.baseUrl);
  const providerFamily = resolveProviderApiFamilyFromId(parsed.provider);
  const resolvedFamily = baseUrlFamily ?? providerFamily;
  const adapterProvider = resolvedFamily === "openai"
    ? resolveOpenAICompatibleAdapterProvider(parsed.provider)
    : resolveAdapterProviderByFamily(resolvedFamily);

  return {
    adapterProvider,
    resolvedModelId: parsed.model,
    modelRef: `${parsed.provider}/${parsed.model}`
  };
}

function normalizeLookupKey(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeOptionalValue(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeFallbackModelRefs(values?: string[]): string[] {
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || normalized.includes(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

export function resolveAgentDefaultStrategy(input: {
  thread?: {
    channelId?: string;
    modelRef?: string;
  };
  globalDefault?: LumeConfigAgentDefaultStrategy;
}): ResolvedAgentDefaultStrategy {
  const threadChannelId = normalizeOptionalValue(input.thread?.channelId);
  const threadModelRef = normalizeOptionalValue(input.thread?.modelRef);
  const globalChannelId = normalizeOptionalValue(input.globalDefault?.defaultChannelId);
  const globalModelRef = normalizeOptionalValue(input.globalDefault?.defaultModelRef);
  const fallbackModelRefs = normalizeFallbackModelRefs(input.globalDefault?.fallbackModelRefs);

  if (threadChannelId || threadModelRef) {
    return {
      source: "thread-override",
      channelId: threadChannelId ?? globalChannelId,
      modelRef: threadModelRef ?? globalModelRef,
      fallbackModelRefs
    };
  }

  if (globalChannelId || globalModelRef || fallbackModelRefs.length > 0) {
    return {
      source: "global-default",
      channelId: globalChannelId,
      modelRef: globalModelRef,
      fallbackModelRefs
    };
  }

  return {
    source: "empty",
    channelId: undefined,
    modelRef: undefined,
    fallbackModelRefs: []
  };
}

export function resolveChannelDefaultModelId(channel: Pick<Channel, "models">): string | null {
  const channelWithDefault = channel as Pick<Channel, "models" | "defaultModelId">;
  const configuredDefault = channelWithDefault.defaultModelId?.trim();
  if (configuredDefault && channel.models.some((model) => model.id === configuredDefault)) {
    return configuredDefault;
  }
  const enabled = channel.models.find((model) => model.enabled && model.id.trim().length > 0);
  if (enabled) {
    return enabled.id;
  }
  const first = channel.models.find((model) => model.id.trim().length > 0);
  return first?.id ?? null;
}

export function resolveRequestedModelIdForChannel(
  channel: Pick<Channel, "models">,
  requestedModelId?: string
): string | null {
  const requested = requestedModelId?.trim();
  if (!requested) {
    return resolveChannelDefaultModelId(channel);
  }

  if (channel.models.some((model) => model.id === requested)) {
    return requested;
  }

  const requestedKey = normalizeLookupKey(requested);
  if (!requested.includes("/")) {
    const aliasMatch = channel.models.find((model) => {
      return (
        normalizeLookupKey(model.alias) === requestedKey ||
        normalizeLookupKey(model.name) === requestedKey ||
        normalizeLookupKey(model.id) === requestedKey
      );
    });
    if (aliasMatch) {
      return aliasMatch.id;
    }
  }

  return requested;
}

export function resolveModelCandidatesForChannel(
  channel: Pick<Channel, "models" | "defaultModelId" | "fallbackModelIds">,
  requestedModelId?: string
): string[] {
  const candidates: string[] = [];
  const push = (value?: string | null): void => {
    const normalized = value?.trim();
    if (!normalized) return;
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  push(resolveRequestedModelIdForChannel(channel, requestedModelId));
  push(resolveChannelDefaultModelId(channel));
  for (const fallback of channel.fallbackModelIds ?? []) {
    push(resolveRequestedModelIdForChannel(channel, fallback));
  }
  for (const model of channel.models) {
    if (model.enabled) {
      push(model.id);
    }
  }
  return candidates;
}
