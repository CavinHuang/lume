import type { ToolActivity } from "@/atoms/agent-atoms";
import { isCanonicalAgentToolName } from "@lume/shared";

export function resolveAgentWatchdogIdleTimeoutMs(activeTools: ToolActivity[]): number {
  const hasRunningWebSearch = activeTools.some((item) => isCanonicalAgentToolName(item.toolName, "web_search"));
  if (hasRunningWebSearch) return 180_000;
  if (activeTools.length > 0) return 120_000;
  return 45_000;
}
