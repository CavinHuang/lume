export type PredefinedRoutineActivity =
  | "reading_note"
  | "reading_progress"
  | "memory_organize"
  | "data_sync"
  | "daily_summary"
  | "weekly_summary"
  | "todo_review"
  | "interest_digest"
  | "work_overview"

export type RoutineActivity = PredefinedRoutineActivity | (string & {})

export type RoutineEntryStatus = "pending" | "running" | "completed" | "skipped" | "failed"
export type RoutineStatus = "planned" | "running" | "completed"

export interface RoutineResult {
  summary: string
  relatedIds?: string[]
}

export interface RoutineEntry {
  id: string
  activity: RoutineActivity
  scheduledAt: number
  status: RoutineEntryStatus
  automationJobId?: string
  result?: RoutineResult
  description?: string
  customName?: string
  customPrompt?: string
}

export interface RoutineContext {
  activeBooks: number
  unfinishedTodos: number
  lastSyncAt?: number
  dayOfWeek: number
  recentNotes: number
  pendingMemories: number
}

export interface DailyRoutine {
  id: string
  date: string
  generatedAt: number
  status: RoutineStatus
  entries: RoutineEntry[]
  context: RoutineContext
  generationSource?: "llm" | "rules"
}

export const ROUTINE_IPC_CHANNELS = {
  GET_TODAY: "routine:get-today",
  TRIGGER_ENTRY: "routine:trigger-entry",
  REGENERATE: "routine:regenerate",
} as const
