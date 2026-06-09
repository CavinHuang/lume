import type { RoutineContext } from "@lume/shared"

export interface LlmRoutinePlan {
  entries: Array<{
    activity: string
    scheduledHour: number
    description?: string
    customName?: string
    customPrompt?: string
  }>
}

/**
 * LLM 日程生成适配器 — 当前为 stub 实现，返回 null 以回退到规则引擎。
 */
export async function generateRoutinePlanWithLlm(
  _context: RoutineContext,
  _date: string,
): Promise<LlmRoutinePlan | null> {
  return null
}
