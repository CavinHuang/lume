import type { Channel } from "@lume/shared";

// 模型引用语法(requested 含 "/" 的 provider/model 形式、trim/lowercase 匹配)在
// channel/model-selection.ts 另有 parseModelRef/normalizeProviderId 一套;改引用
// 语义时两处需同步(#504 知识分裂注记)。

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
      return aliasMatch.enabled ? aliasMatch.id : resolveChannelDefaultModelId(channel);
    }
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
