import type { DailyRoutine, RoutineContext, RoutineEntry, RoutineActivity } from "@lume/shared"
import { listReadingBooks, getReadingSettings, listReadingNotes } from "../reading/reading-store"
import { getApplicableActivities } from "./routine-activities"
import { writeRoutine, readRoutine } from "./routine-store"
import { generateRoutinePlanWithLlm, type LlmRoutinePlan } from "./routine-llm-adapter"

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function collectRoutineContext(): RoutineContext {
  const now = Date.now()
  const books = listReadingBooks()
  const activeBooks = books.filter((b) => b.status !== "finished").length
  const notes = listReadingNotes({ includeHidden: true })
  const recentNotes = notes.filter((n) => now - n.createdAt < 7 * 86400_000).length
  const settings = getReadingSettings()

  return {
    activeBooks,
    unfinishedTodos: 0,
    lastSyncAt: settings.weread.lastSyncAt,
    dayOfWeek: new Date().getDay(),
    recentNotes,
    pendingMemories: 0,
  }
}

function buildTimeSlots(date: string): number[] {
  const parts = date.split("-")
  const base = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getTime()
  const slots: number[] = []
  for (let hour = 8; hour <= 21; hour++) {
    slots.push(base + hour * 3600_000)
  }
  return slots
}

const PRIORITY_ORDER: RoutineActivity[] = [
  "data_sync",
  "memory_organize",
  "work_overview",
  "reading_progress",
  "reading_note",
  "todo_review",
  "interest_digest",
  "weekly_summary",
  "daily_summary",
]

export async function generateDailyRoutine(overrideDate?: string, force?: boolean): Promise<DailyRoutine> {
  const date = overrideDate ?? today()

  if (!force) {
    const existing = readRoutine(date)
    if (existing) return existing
  }

  const context = collectRoutineContext()

  // Try LLM generation first
  try {
    const llmPlan = await generateRoutinePlanWithLlm(context, date)
    if (llmPlan && llmPlan.entries.length > 0) {
      const routine = buildRoutineFromLlmPlan(llmPlan, context, date)
      writeRoutine(routine)
      return routine
    }
  } catch (error) {
    console.warn("[日程] LLM 生成失败，回退到规则引擎:", error instanceof Error ? error.message : String(error))
  }

  // Fallback: rule-based generation
  const routine = generateRuleBasedRoutine(context, date)
  writeRoutine(routine)
  return routine
}

function buildRoutineFromLlmPlan(plan: LlmRoutinePlan, context: RoutineContext, date: string): DailyRoutine {
  const slots = buildTimeSlots(date)

  const entries: RoutineEntry[] = plan.entries.map((item, index) => {
    const hour = Math.max(8, Math.min(21, item.scheduledHour))
    const scheduledAt = slots[hour - 8] ?? slots[0]!

    return {
      id: `entry-${item.activity}-${index}`,
      activity: item.activity as RoutineActivity,
      scheduledAt,
      status: "pending" as const,
      description: item.description || undefined,
      ...(item.customName ? { customName: item.customName } : {}),
      ...(item.customPrompt ? { customPrompt: item.customPrompt } : {}),
    }
  })

  return {
    id: `routine-${date}`,
    date,
    generatedAt: Date.now(),
    status: "planned",
    entries,
    context,
    generationSource: "llm",
  }
}

function generateRuleBasedRoutine(context: RoutineContext, date: string): DailyRoutine {
  const applicable = getApplicableActivities(context)

  let entries: RoutineEntry[] = applicable.map((executor, index) => ({
    id: `entry-${executor.activity}-${index}`,
    activity: executor.activity,
    scheduledAt: 0,
    status: "pending" as const,
  }))

  const slots = buildTimeSlots(date)
  entries = [...entries].sort((a, b) => {
    const aIndex = PRIORITY_ORDER.indexOf(a.activity)
    const bIndex = PRIORITY_ORDER.indexOf(b.activity)
    const aPriority = aIndex === -1 ? 999 : aIndex
    const bPriority = bIndex === -1 ? 999 : bIndex
    return aPriority - bPriority
  }).map((entry, index) => {
    const slotIndex = Math.min(index, slots.length - 1)
    entry.scheduledAt = slots[slotIndex]!
    return entry
  })

  return {
    id: `routine-${date}`,
    date,
    generatedAt: Date.now(),
    status: "planned",
    entries,
    context,
    generationSource: "rules",
  }
}
