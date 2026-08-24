/**
 * 思考预算表与档位反查(#561)。
 * 住在 model-runtime:provider 反查档位是唯一下游消费方,agent-runtime/runner 的
 * thinking-level 自此处 re-export——保持 runner 侧 importer API 不变,同时不产生
 * model-runtime→agent-runtime 的分层逆向边(#631 review)。
 */

export type ThinkingBudgetLevel = "high" | "medium" | "low" | "xhigh";

export const THINKING_TOKEN_BUDGETS: Record<ThinkingBudgetLevel, number> = {
  high: 8_192,
  medium: 4_096,
  low: 1_024,
  xhigh: 16_384
};

/** 由预算数值反查档位(#561):engine 侧只透传 budget_tokens,provider 需还原等级才能驱动 reasoning。 */
export function resolveThinkingLevelFromBudget(budgetTokens: number): ThinkingBudgetLevel {
  if (budgetTokens >= THINKING_TOKEN_BUDGETS.xhigh) return "xhigh";
  if (budgetTokens >= THINKING_TOKEN_BUDGETS.high) return "high";
  if (budgetTokens >= THINKING_TOKEN_BUDGETS.medium) return "medium";
  return "low";
}
