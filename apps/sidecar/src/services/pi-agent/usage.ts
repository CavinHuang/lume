import type { AgentEventUsage } from "@lume/shared";

export function resolveAgentEventTotalTokens(usage: AgentEventUsage): number {
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
    return usage.totalTokens;
  }

  return usage.inputTokens
    + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheCreationTokens ?? 0);
}
