import { randomUUID } from "node:crypto"
import type { DailyRoutine, RoutineContext, RoutineEntry, RoutineActivity } from "@lume/shared"
import { listReadingBooks, getReadingSettings, listReadingNotes } from "../reading/reading-store"
import { getApplicableActivities } from "./routine-activities"
import { writeRoutine, readRoutine } from "./routine-store"

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

export function generateDailyRoutine(overrideDate?: string): DailyRoutine {
  const date = overrideDate ?? today()

  const existing = readRoutine(date)
  if (existing) return existing

  const context = collectRoutineContext()
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

  const routine: DailyRoutine = {
    id: `routine-${date}`,
    date,
    generatedAt: Date.now(),
    status: "planned",
    entries,
    context,
  }

  writeRoutine(routine)
  return routine
}
