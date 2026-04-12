import type { Channel } from "@lume/shared";

export interface ResolvedChannelModelSelection {
  channelId: string;
  modelId: string;
  modelRef: string;
}

export function resolveChannelModelSelectionFromRef(
  channels: Channel[],
  modelRef: string | undefined,
  capability?: "chat" | "embedding"
): ResolvedChannelModelSelection | null {
  const trimmed = modelRef?.trim();
  if (!trimmed) {
    return null;
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
  const modelId = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    return null;
  }

  const channel = channels.find((item) => {
    if (!item.enabled || item.provider !== provider) {
      return false;
    }
    return item.models.some((model) => {
      if (!model.enabled || model.id !== modelId) {
        return false;
      }
      if (!capability) {
        return true;
      }
      return model.capabilities?.[capability] === true;
    });
  });

  if (!channel) {
    return null;
  }

  return {
    channelId: channel.id,
    modelId,
    modelRef: `${provider}/${modelId}`
  };
}
