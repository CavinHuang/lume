import { createLogContentDigest } from "../infra/log-digest";

function shortenId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 8);
}

function previewText(value: string | undefined, maxLength = 256): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

export function buildAgentContentLogData(role: "user" | "assistant", content: string): Record<string, unknown> {
  const digest = createLogContentDigest(content, `agent-content:${role}`);
  return {
    role,
    contentLength: content.length,
    contentDigest: digest.digest,
    contentDigestAlgorithm: digest.algorithm,
    contentDigestKeyVersion: digest.keyVersion,
    contentDigestScope: digest.scope,
    contentPreview: previewText(content)
  };
}

export function buildAgentSendStartLogData(input: {
  threadId: string;
  workspaceId?: string;
  channelId?: string;
  modelId?: string;
  modelRef?: string;
  appendUserMessage: boolean;
  userMessage?: string;
}): Record<string, unknown> {
  return {
    threadId: shortenId(input.threadId),
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    modelId: input.modelId,
    modelRef: input.modelRef,
    appendUserMessage: input.appendUserMessage,
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
