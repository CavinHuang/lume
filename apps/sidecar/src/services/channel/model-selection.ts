import type { LumeConfigAgentDefaultStrategy } from "@lume/shared";

// 模型适配的 API 协议族决策由 model-runtime/connection-provider 按
// channel.provider/openaiApiMode 直判——本文件曾有平行实现
// resolveChannelModelSelection(baseUrl 推断),因生产零消费于 #627 清偿中删除。

export type AgentDefaultStrategySource = "thread-override" | "global-default" | "empty";

export interface ResolvedAgentDefaultStrategy {
  source: AgentDefaultStrategySource;
  channelId?: string;
  modelRef?: string;
  fallbackModelRefs: string[];
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

