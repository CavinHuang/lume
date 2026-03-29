import type { Channel, ModelOption } from "@lume/shared";

export function buildModelOptions(channels: Channel[], filterChannelId?: string): ModelOption[] {
  const options: ModelOption[] = [];
  for (const channel of channels) {
    if (!channel.enabled) continue;
    if (filterChannelId && channel.id !== filterChannelId) continue;
    const fallbackIds = new Set(channel.fallbackModelIds ?? []);
    const sortedModels = [...channel.models].sort((a, b) => {
      const aDefault = channel.defaultModelId === a.id ? 1 : 0;
      const bDefault = channel.defaultModelId === b.id ? 1 : 0;
      if (aDefault !== bDefault) return bDefault - aDefault;
      const aEnabled = a.enabled ? 1 : 0;
      const bEnabled = b.enabled ? 1 : 0;
      if (aEnabled !== bEnabled) return bEnabled - aEnabled;
      return a.name.localeCompare(b.name);
    });
    for (const model of sortedModels) {
      if (!model.enabled) continue;
      options.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelRef: model.id.includes("/") ? model.id : `${channel.provider}/${model.id}`,
        modelName: model.name,
        modelAlias: model.alias,
        isDefault: channel.defaultModelId === model.id,
        isFallback: fallbackIds.has(model.id),
        provider: channel.provider
      });
    }
  }
  return options;
}

export function groupModelOptionsByChannel(options: ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>();
  for (const option of options) {
    const group = groups.get(option.channelId) ?? [];
    group.push(option);
    groups.set(option.channelId, group);
  }
  return groups;
}

export function filterGroupedModelOptions(
  grouped: Map<string, ModelOption[]>,
  search: string
): Map<string, ModelOption[]> {
  if (!search.trim()) {
    return grouped;
  }
  const query = search.toLowerCase();
  const filtered = new Map<string, ModelOption[]>();
  for (const [channelId, options] of grouped.entries()) {
    const matched = options.filter((item) => (
      item.modelName.toLowerCase().includes(query)
      || item.channelName.toLowerCase().includes(query)
      || item.modelId.toLowerCase().includes(query)
      || item.modelRef?.toLowerCase().includes(query)
      || item.modelAlias?.toLowerCase().includes(query)
    ));
    if (matched.length > 0) {
      filtered.set(channelId, matched);
    }
  }
  return filtered;
}

export function resolveModelHighlightIndex(
  options: ModelOption[],
  selectedModel: { channelId: string; modelId: string } | null
): number {
  if (!selectedModel) {
    return options.length > 0 ? 0 : -1;
  }
  const index = options.findIndex((item) => (
    item.channelId === selectedModel.channelId
    && item.modelId === selectedModel.modelId
  ));
  if (index !== -1) {
    return index;
  }
  return options.length > 0 ? 0 : -1;
}

export function resolveModelMetaLabel(option: ModelOption): string {
  if (option.isDefault) {
    return "默认";
  }
  if (option.isFallback) {
    return "回退";
  }
  if (option.modelAlias) {
    return option.modelAlias;
  }
  return option.provider.toUpperCase();
}
