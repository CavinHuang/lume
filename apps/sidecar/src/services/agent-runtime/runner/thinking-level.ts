export type ResolvedThinkingLevel = "auto" | "high" | "medium" | "low" | "xhigh" | "off";

export interface ThinkingLevelAgent {
  setMaxThinkingTokens(value: number | null): Promise<void>;
}

const THINKING_TOKEN_BUDGETS: Record<Exclude<ResolvedThinkingLevel, "auto" | "off">, number> = {
  high: 8_192,
  medium: 4_096,
  low: 1_024,
  xhigh: 16_384
};

/** 由预算数值反查档位(#561):engine 侧只透传 budget_tokens,provider 需还原等级才能驱动 reasoning。 */
export function resolveThinkingLevelFromBudget(budgetTokens: number): Exclude<ResolvedThinkingLevel, "auto" | "off"> {
  if (budgetTokens >= THINKING_TOKEN_BUDGETS.xhigh) return "xhigh";
  if (budgetTokens >= THINKING_TOKEN_BUDGETS.high) return "high";
  if (budgetTokens >= THINKING_TOKEN_BUDGETS.medium) return "medium";
  return "low";
}

export async function applyResolvedThinkingLevel(
  agent: ThinkingLevelAgent,
  thinkingLevel: ResolvedThinkingLevel | undefined
): Promise<void> {
  if (!thinkingLevel || thinkingLevel === "auto") {
    return;
  }
  if (thinkingLevel === "off") {
    await agent.setMaxThinkingTokens(null);
    return;
  }
  await agent.setMaxThinkingTokens(THINKING_TOKEN_BUDGETS[thinkingLevel]);
}
