import type { ChatToolActivity } from "@lume/shared";

export interface AgentModeRecommendation {
  reason: string;
  suggestedPrompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function extractAgentModeRecommendation(
  activities?: ChatToolActivity[]
): AgentModeRecommendation | null {
  if (!activities || activities.length === 0) return null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.type !== "result") continue;
    if (activity.toolName !== "suggest_agent_mode" || activity.isError || !activity.result) continue;

    try {
      const parsed = JSON.parse(activity.result) as unknown;
      if (!isRecord(parsed) || parsed.type !== "agent_recommendation") continue;
      const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
      const suggestedPrompt = typeof parsed.suggestedPrompt === "string" ? parsed.suggestedPrompt.trim() : "";
      if (!reason || !suggestedPrompt) continue;
      return { reason, suggestedPrompt };
    } catch {
      continue;
    }
  }
  return null;
}
