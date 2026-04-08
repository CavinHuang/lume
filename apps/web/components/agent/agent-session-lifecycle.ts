import type { AgentMessage, AgentThreadMeta, Channel } from "@lume/shared";

export function extractLatestAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const text = (message.content ?? "").trim();
    if (text.length > 0) return text;
  }
  return "";
}

export function pickDefaultEnabledModelId(channel: Channel | undefined): string | null {
  if (!channel) return null;
  const configuredDefault = channel.defaultModelId?.trim();
  if (configuredDefault && channel.models.some((model) => model.enabled && model.id === configuredDefault)) {
    return configuredDefault;
  }
  return channel.models.find((model) => model.enabled)?.id ?? null;
}

export function resolvePreferredAgentSelection(input: {
  channels: Channel[];
  thread: Pick<AgentThreadMeta, "channelId" | "modelId"> | null;
  currentChannelId: string | null;
  currentModelId: string | null;
}): {
  channelId: string | null;
  modelId: string | null;
} {
  const enabledChannels = input.channels.filter((item) => item.enabled);
  const preferredChannel =
    (input.thread?.channelId ? enabledChannels.find((item) => item.id === input.thread?.channelId) : undefined)
    ?? (input.currentChannelId ? enabledChannels.find((item) => item.id === input.currentChannelId) : undefined)
    ?? enabledChannels[0];

  if (!preferredChannel) {
    return {
      channelId: null,
      modelId: null
    };
  }

  const preferredModelId =
    (input.thread?.modelId && preferredChannel.models.some((model) => model.enabled && model.id === input.thread?.modelId)
      ? input.thread.modelId
      : null)
    ?? (input.currentModelId && preferredChannel.models.some((model) => model.enabled && model.id === input.currentModelId)
      ? input.currentModelId
      : null)
    ?? pickDefaultEnabledModelId(preferredChannel);

  return {
    channelId: preferredChannel.id,
    modelId: preferredModelId ?? null
  };
}
