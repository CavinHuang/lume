import type { AgentMessage, AgentSessionMeta, Channel } from "@lume/shared";

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseExitPlanResult(result: string): {
  planPath: string | null;
  slug?: string;
  metadata?: {
    summary?: string;
    estimatedFiles?: number;
    estimatedLines?: number;
  };
} {
  const findPlanPayload = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.planPath === "string" && record.planPath.trim().length > 0) {
      return record;
    }
    if (record.details && typeof record.details === "object") {
      const nested = findPlanPayload(record.details);
      if (nested) return nested;
    }
    if (Array.isArray(record.content)) {
      for (const item of record.content) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== "string") continue;
        const parsed = tryParseJson(text);
        const nested = findPlanPayload(parsed);
        if (nested) return nested;
      }
    }
    return null;
  };

  const parsed = tryParseJson(result);
  const payload = parsed ? findPlanPayload(parsed) : null;
  if (!payload) {
    return { planPath: null };
  }

  const planPath = typeof payload.planPath === "string" ? payload.planPath.trim() : "";
  const slug = typeof payload.slug === "string" ? payload.slug.trim() : "";
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  const estimatedFiles = typeof payload.estimatedFiles === "number" ? payload.estimatedFiles : undefined;
  const estimatedLines = typeof payload.estimatedLines === "number" ? payload.estimatedLines : undefined;

  return {
    planPath: planPath || null,
    slug: slug || undefined,
    metadata: summary || estimatedFiles !== undefined || estimatedLines !== undefined
      ? {
        ...(summary ? { summary } : {}),
        ...(estimatedFiles !== undefined ? { estimatedFiles } : {}),
        ...(estimatedLines !== undefined ? { estimatedLines } : {})
      }
      : undefined
  };
}

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

export function recoverPlanFromMessages(messages: AgentMessage[]): {
  planPath: string | null;
  draft: string;
} {
  let hasPlanSignal = false;
  let latestAssistantText = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant" && latestAssistantText.length === 0) {
      const text = (message.content ?? "").trim();
      if (text.length > 0) {
        latestAssistantText = text;
      }
    }
    if (!message || !message.events) continue;
    for (let j = message.events.length - 1; j >= 0; j -= 1) {
      const event = message.events[j];
      if (!event) continue;
      if (event.type === "tool_start" && event.toolName === "EnterPlanMode") {
        hasPlanSignal = true;
        continue;
      }
      if (event.type === "tool_result" && event.toolName === "ExitPlanMode" && !event.isError) {
        hasPlanSignal = true;
      }
      if (event.type !== "tool_result" || event.isError || event.toolName !== "ExitPlanMode") {
        continue;
      }
      const parsed = parseExitPlanResult(event.result);
      const messageText = (message.content ?? "").trim();
      if (messageText.length > 0) {
        return { planPath: parsed.planPath, draft: messageText };
      }
      for (let k = i - 1; k >= 0; k -= 1) {
        const prev = messages[k];
        if (!prev || prev.role !== "assistant") continue;
        const prevText = (prev.content ?? "").trim();
        if (prevText.length > 0) {
          return { planPath: parsed.planPath, draft: prevText };
        }
      }
      return { planPath: parsed.planPath, draft: "" };
    }
  }
  if (hasPlanSignal && latestAssistantText.length > 0) {
    return { planPath: null, draft: latestAssistantText };
  }
  return { planPath: null, draft: "" };
}

export function resolvePreferredAgentSelection(input: {
  channels: Channel[];
  session: Pick<AgentSessionMeta, "channelId" | "modelId"> | null;
  currentChannelId: string | null;
  currentModelId: string | null;
}): {
  channelId: string | null;
  modelId: string | null;
} {
  const enabledChannels = input.channels.filter((item) => item.enabled);
  const preferredChannel =
    (input.session?.channelId ? enabledChannels.find((item) => item.id === input.session?.channelId) : undefined)
    ?? (input.currentChannelId ? enabledChannels.find((item) => item.id === input.currentChannelId) : undefined)
    ?? enabledChannels[0];

  if (!preferredChannel) {
    return {
      channelId: null,
      modelId: null
    };
  }

  const preferredModelId =
    (input.session?.modelId && preferredChannel.models.some((model) => model.enabled && model.id === input.session?.modelId)
      ? input.session.modelId
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
