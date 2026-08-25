import type { LumeConfigAgentDefaultStrategy, ProviderType } from "@lume/shared";

// 纯函数簇已下移 runtime-core/model-candidates(#289 分层切边);此处 re-export 维持既有 import 路径。
export {
  resolveChannelDefaultModelId,
  resolveRequestedModelIdForChannel,
  resolveModelCandidatesForChannel
} from "../agent-runtime/runtime-core/model-candidates";

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
    "openai-codex",
    "github-copilot",
    "xai",
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
    "ollama",
    "lmstudio",
    "opencode",
    "custom",
    "aliyun-coding-plan",
    "volcengine-coding-plan",
    "minimax-token-plan",
    "xiaomi-token-plan",
    "stepfun",
    "stepfun-coding-plan",
  ] as const).includes(provider as ProviderType)
    ? (provider as ProviderType)
    : "custom";
}

export function resolveChannelModelSelection(input: {
  channelProvider: ProviderType;
  baseUrl: string;
  modelId: string;
  apiFamily?: string;
  openaiApiMode?: 'chat-completions' | 'responses';
  channelProviderId?: string;
}): {
  adapterProvider: ProviderType;
  resolvedModelId: string;
  modelRef: string;
  openaiApiMode?: 'chat-completions' | 'responses';
} {
  const effectiveProvider = input.channelProviderId ?? input.channelProvider;
  const parsed = parseModelRef(input.modelId, effectiveProvider);
  if (!parsed) {
    return {
      adapterProvider: input.channelProvider,
      resolvedModelId: input.modelId,
      modelRef: `${effectiveProvider}/${input.modelId}`
    };
  }

  const baseUrlFamily = resolveProviderApiFamilyFromBaseUrl(input.baseUrl);
  const providerFamily = input.channelProvider === "custom" && input.apiFamily
    ? input.apiFamily as ProviderApiFamily
    : resolveProviderApiFamilyFromId(parsed.provider);
  const resolvedFamily = input.channelProvider === "custom" && input.apiFamily
    ? input.apiFamily as ProviderApiFamily
    : (baseUrlFamily ?? providerFamily);
  const adapterProvider = resolvedFamily === "openai"
    ? resolveOpenAICompatibleAdapterProvider(parsed.provider)
    : resolveAdapterProviderByFamily(resolvedFamily);

  return {
    adapterProvider,
    resolvedModelId: parsed.model,
    modelRef: `${parsed.provider}/${parsed.model}`,
    openaiApiMode: input.openaiApiMode,
  };
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

