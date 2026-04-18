import { getSubagentRunRegistry } from "../../agent/subagents/subagent-run-registry";

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSubagentInteractiveLabel(subagentRunId?: string): string | undefined {
  if (!subagentRunId) {
    return undefined;
  }
  const run = getSubagentRunRegistry().get(subagentRunId);
  if (!run) {
    return undefined;
  }
  return (
    normalizeLabel(run.label)
    ?? normalizeLabel(run.requestedAgentId)
    ?? normalizeLabel(run.resolvedAgentId)
  );
}
