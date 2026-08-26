import type { Channel } from "@lume/shared";

// 模型引用语法与渠道模型解析的单一来源(#581:此前 resolve* 族在
// runtime-core/model-candidates、parseModelRef 族在 channel/model-selection
// 各存一份靠注释人肉同步,#504 已为此付过学费)。kernel 与 channel 域均向下
// 引用本文件,不再互相依赖。

export interface ModelRef {
  provider: string;
  model: string;
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

/** 解析 `provider/model` 复合引用;不含 "/" 时回落到 defaultProvider。 */
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

function normalizeLookupKey(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

/** 渠道默认模型解析(纯函数,自 channel/model-selection 下移,#289 分层切边)。 */
export function resolveChannelDefaultModelId(channel: Pick<Channel, "models" | "defaultModelId">): string | null {
  const configuredDefault = channel.defaultModelId?.trim();
  if (configuredDefault && channel.models.some((model) => model.id === configuredDefault && model.enabled)) {
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

  const exactMatch = channel.models.find((model) => model.id === requested);
  if (exactMatch) {
    return exactMatch.enabled ? requested : resolveChannelDefaultModelId(channel);
  }

  // 含 "/" 的复合引用(provider/model)视为精确引用,不做 alias/name 匹配。
  if (requested.includes("/")) {
    return requested;
  }

  const requestedKey = normalizeLookupKey(requested);
  const aliasMatch = channel.models.find((model) => {
    return (
      normalizeLookupKey(model.alias) === requestedKey ||
      normalizeLookupKey(model.name) === requestedKey ||
      normalizeLookupKey(model.id) === requestedKey
    );
  });
  if (aliasMatch) {
    return aliasMatch.enabled ? aliasMatch.id : resolveChannelDefaultModelId(channel);
  }

  return requested;
}

/**
 * 渠道模型候选序列:请求模型 → 渠道默认 → fallback 列表 → 全部启用模型。
 * 纯函数;调用方(runtime-core/model.ts)不得反向依赖 services/channel。
 */
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
