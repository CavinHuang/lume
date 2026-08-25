import { THINKING_TOKEN_BUDGETS, type ThinkingBudgetLevel } from "../../model-runtime/thinking-budgets";

export type ResolvedThinkingLevel = "auto" | ThinkingBudgetLevel | "off";

export interface ThinkingLevelAgent {
  setMaxThinkingTokens(value: number | null): Promise<void>;
}

export { THINKING_TOKEN_BUDGETS, resolveThinkingLevelFromBudget } from "../../model-runtime/thinking-budgets";

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
