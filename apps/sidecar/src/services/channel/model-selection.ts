import type { LumeConfigAgentDefaultStrategy } from "@lume/shared";

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
