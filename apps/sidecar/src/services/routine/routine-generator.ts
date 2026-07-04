import type { DailyRoutine, RoutineContext, RoutineEntry, RoutineActivity } from "@lume/shared"
import { listReadingBooks, getReadingSettings, listReadingNotes } from "../reading/reading-store"
import { getApplicableActivities } from "./routine-activities"
import { writeRoutine, readRoutine } from "./routine-store"
import { generateRoutinePlanWithLlm, type LlmRoutinePlan } from "./routine-llm-adapter"
import { createLogger } from "../infra/logger"

const log = createLogger("routine")

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function collectRoutineContext(): RoutineContext {
  const now = Date.now()
  const books = listReadingBooks()
  const activeBooks = books.filter((b) => b.status !== "finished").length
  const queuedBooks = books.filter((b) => b.status === "queued").length
  const notes = listReadingNotes({ includeHidden: true })
  const recentNotes = notes.filter((n) => now - n.createdAt < 7 * 86400_000).length
  const settings = getReadingSettings()

  return {
    activeBooks,
    queuedBooks,
    unfinishedTodos: 0,
    lastSyncAt: settings.weread.lastSyncAt,
    dayOfWeek: new Date().getDay(),
    recentNotes,
    pendingMemories: 0,
  }
}

function buildTimeSlots(date: string, futureOnly = false): number[] {
  const parts = date.split("-")
  const base = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getTime()
  const now = Date.now()
  const slots: number[] = []
  for (let hour = 8; hour <= 21; hour++) {
    const slot = base + hour * 3600_000
    if (!futureOnly || slot > now) {
      slots.push(slot)
    }
  }
  return slots
}

/** 将 N 个活动均匀分布到 totalSlots 个时间槽中，返回每个活动对应的槽位索引 */
function distributeEvenly(count: number, totalSlots: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [Math.floor(totalSlots / 2)]
  if (count >= totalSlots) return Array.from({ length: totalSlots }, (_, i) => i)
  const indices: number[] = []
  for (let i = 0; i < count; i++) {
    indices.push(Math.round((i * (totalSlots - 1)) / (count - 1)))
  }
  return indices
}

const PRIORITY_ORDER: RoutineActivity[] = [
  "data_sync",
  "memory_organize",
  "work_overview",
  "reading_progress",
  "reading_note",
  "book_discover",
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

  // force 重新生成时，保留已完成/进行中的条目
  let preservedEntries: RoutineEntry[] = []
  let preservedEntryIds = new Set<string>()
  if (force) {
    const existing = readRoutine(date)
    if (existing) {
      preservedEntries = existing.entries.filter(
        (e) => e.status === "completed" || e.status === "running",
      )
      preservedEntryIds = new Set(preservedEntries.map((e) => e.id))
      log.info("重新生成日程，保留已完成条目", {
        date,
        preservedCount: preservedEntries.length,
        preservedIds: [...preservedEntryIds],
      })
    }
  }

  // Try LLM generation first
  try {
    const llmPlan = await generateRoutinePlanWithLlm(context, date)
    if (llmPlan && llmPlan.entries.length > 0) {
      // 不再按 activity 名称过滤，允许同一活动类型多次安排
      // 保留的已完成/进行中条目会和新条目共存
      const routine = buildRoutineFromLlmPlan(llmPlan, context, date, preservedEntries, force)
      writeRoutine(routine)
      return routine
    }
  } catch (error) {
    log.warn("LLM 生成失败，回退到规则引擎", { error: error instanceof Error ? error.message : String(error) })
  }

  // Fallback: rule-based generation
  const routine = generateRuleBasedRoutine(context, date, preservedEntries, force)
  writeRoutine(routine)
  log.info("日程生成完成", {
    date,
    source: routine.generationSource,
    totalEntries: routine.entries.length,
    newEntries: routine.entries.filter((e) => e.status === "pending").length,
    preservedEntries: preservedEntries.length,
    activities: routine.entries.map((e) => `${e.activity}@${new Date(e.scheduledAt).getHours()}:00`),
  })
  return routine
}

function buildRoutineFromLlmPlan(
  plan: LlmRoutinePlan,
  context: RoutineContext,
  date: string,
  preservedEntries: RoutineEntry[] = [],
  futureOnly = false,
): DailyRoutine {
  const slots = buildTimeSlots(date, futureOnly)

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
    entries: [...preservedEntries, ...entries],
    context,
    generationSource: "llm",
  }
}

function generateRuleBasedRoutine(
  context: RoutineContext,
  date: string,
  preservedEntries: RoutineEntry[] = [],
  futureOnly = false,
): DailyRoutine {
  const applicable = getApplicableActivities(context)

  const slots = buildTimeSlots(date, futureOnly)

  // 对 reading_progress 和 reading_note，按活跃书籍数复制条目，支持多次安排
  let entries: RoutineEntry[] = []
  applicable.forEach((executor, idx) => {
    const count = (executor.activity === "reading_progress" || executor.activity === "reading_note")
      ? Math.max(1, context.activeBooks)
      : 1;
    for (let i = 0; i < count; i++) {
      entries.push({
        id: `entry-${executor.activity}-${idx}-${i}`,
        activity: executor.activity,
        scheduledAt: 0,
        status: "pending" as const,
      })
    }
  })

  // 按优先级排序
  entries = [...entries].sort((a, b) => {
    const aIndex = PRIORITY_ORDER.indexOf(a.activity)
    const bIndex = PRIORITY_ORDER.indexOf(b.activity)
    const aPriority = aIndex === -1 ? 999 : aIndex
    const bPriority = bIndex === -1 ? 999 : bIndex
    return aPriority - bPriority
  })

  // 均匀分配到可用时间槽，覆盖全天
  if (slots.length === 0) {
    const now = Date.now()
    entries.forEach((entry, index) => {
      entry.scheduledAt = now + index * 60_000
    })
  } else {
    const slotIndices = distributeEvenly(entries.length, slots.length)
    entries.forEach((entry, index) => {
      const slotIndex = slotIndices[index] ?? slots.length - 1
      entry.scheduledAt = slots[slotIndex]!
    })
  }

  const allEntries = [...preservedEntries, ...entries]
  return {
    id: `routine-${date}`,
    date,
    generatedAt: Date.now(),
    status: allEntries.every((e) => e.status === "completed" || e.status === "skipped" || e.status === "failed")
      ? "completed"
      : allEntries.some((e) => e.status === "running")
        ? "running"
        : "planned",
    entries: allEntries,
    context,
    generationSource: "rules",
  }
}
