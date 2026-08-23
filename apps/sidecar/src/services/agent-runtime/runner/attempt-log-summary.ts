function shortenId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 8);
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
