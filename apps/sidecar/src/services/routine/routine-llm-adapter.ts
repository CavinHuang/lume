import type { RoutineContext } from "@lume/shared"
import { resolveChannelModelBinding } from "../channel/channel-manager"
import { createConnectionLlmProvider } from "../model-runtime/connection-provider"
import { getEffectiveLumeConfig } from "../system/lume-config-service"
import { createLogger } from "../infra/logger"

const log = createLogger("routine-llm")

export interface LlmRoutineEntry {
  activity: string
  scheduledHour: number
  description: string
  customName?: string
  customPrompt?: string
}

export interface LlmRoutinePlan {
  entries: LlmRoutineEntry[]
}

export async function generateRoutinePlanWithLlm(
  context: RoutineContext,
  date: string
): Promise<LlmRoutinePlan | undefined> {
  const config = getEffectiveLumeConfig()
  const modelRef = config.models?.routine?.defaultModelRef || config.models?.agent?.defaultModelRef || config.models?.chat?.defaultModelRef
  if (!modelRef) return undefined

  const binding = resolveChannelModelBinding(modelRef, "chat")
  if (!binding) return undefined

  const provider = await createConnectionLlmProvider({
    channel: binding.channel,
    modelId: binding.modelId,
  })

  log.debug("generating routine plan with LLM", { provider: binding.channel.provider, modelId: binding.modelId })

  const response = await provider.createMessage({
    model: binding.modelId,
    maxTokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: JSON.stringify({ date, ...context }),
      },
    ],
  })

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")
    .trim()

  if (!text) return undefined

  const plan = parseJsonResponse(text)
  if (!plan?.entries?.length) return undefined

  return plan
}

function parseJsonResponse(text: string): LlmRoutinePlan | undefined {
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()

  try {
    const parsed = JSON.parse(cleaned)
    if (!parsed || !Array.isArray(parsed.entries)) return undefined
    // Validate each entry has required fields
    for (const entry of parsed.entries) {
      if (typeof entry.activity !== "string" || typeof entry.scheduledHour !== "number") {
        return undefined
      }
      entry.scheduledHour = Math.max(8, Math.min(21, Math.round(entry.scheduledHour)))
      entry.description = typeof entry.description === "string" ? entry.description : ""
    }
    return parsed as LlmRoutinePlan
  } catch {
    return undefined
  }
}

const SYSTEM_PROMPT = `你是用户的个人日程规划助手。根据用户当前的上下文，决定今天应该安排哪些活动以及什么时间执行。

## 预定义活动类型
- data_sync: 同步微信读书数据（书架、进度、划线、书签）
- reading_progress: 推进在读书籍的阅读进度
- reading_note: 为在读书籍生成读书笔记
- memory_organize: 整理近期对话和记忆条目
- todo_review: 检查待办事项并生成提醒
- interest_digest: 根据用户兴趣搜索并聚合资讯
- work_overview: 生成今日工作概览（工作日）
- daily_summary: 汇总今天日程执行结果
- weekly_summary: 生成本周总结（周日）

## 规则
- 时间范围 8:00-21:00，合理安排间隔
- 通常安排 5-12 个活动
- 读书相关活动（reading_progress、reading_note）可以根据在读书籍数量安排多次，分散在不同时间段
- daily_summary 必须安排在最后一个（建议 20-21 点）
- 周日（dayOfWeek=0）应包含 weekly_summary
- 根据上下文判断哪些活动相关，不必全部包含
- 可以创建预定义之外的自定义活动，例如"整理书架"、"回顾笔记"等

## 自定义活动
如果某个活动不在预定义类型中，使用自定义活动：
- activity 字段用英文 kebab-case 标识符（如 "bookshelf_organize"）
- 必须提供 customName（中文显示名称）
- 必须提供 customPrompt（执行该活动时给 AI 的指令）

## 回复格式
只返回纯 JSON，不要任何额外文字：
{
  "entries": [
    {
      "activity": "data_sync",
      "scheduledHour": 8,
      "description": "早上先同步最新数据"
    },
    {
      "activity": "custom_idea",
      "scheduledHour": 14,
      "description": "下午精力好，适合深度思考",
      "customName": "灵感记录",
      "customPrompt": "回顾今天的阅读内容和对话，提取 3 个值得记录的灵感或想法，整理成简短的笔记。"
    }
  ]
}`
