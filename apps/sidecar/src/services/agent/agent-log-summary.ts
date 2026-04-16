function shortenId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 8);
}

function previewText(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

export function buildAgentSendStartLogData(input: {
  threadId: string;
  workspaceId?: string;
  channelId?: string;
  modelId?: string;
  modelRef?: string;
  appendUserMessage: boolean;
  preferredCapabilityRoute?: string;
  capabilityLanes?: string[];
  userMessage?: string;
}): Record<string, unknown> {
  return {
    threadId: shortenId(input.threadId),
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    modelId: input.modelId,
    modelRef: input.modelRef,
    appendUserMessage: input.appendUserMessage,
    preferredCapabilityRoute: input.preferredCapabilityRoute,
    capabilityLanes: input.capabilityLanes,
    userMessagePreview: previewText(input.userMessage)
  };
}

export function buildRuntimeAttemptLogData(input: {
  sessionId: string;
  workspaceSlug?: string;
  provider: string;
  modelId: string;
  resume: boolean;
  permissionMode?: string;
  cwd: string;
  toolCount?: number;
}): Record<string, unknown> {
  return {
    sessionId: shortenId(input.sessionId),
    workspaceSlug: input.workspaceSlug,
    provider: input.provider,
    modelId: input.modelId,
    resume: input.resume,
    permissionMode: input.permissionMode,
    cwd: input.cwd,
    toolCount: input.toolCount
  };
}

