import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import type { DailyRoutine, RoutineEntryStatus, RoutineStatus } from "@lume/shared"
import { getRoutineSchedulePath, getRoutineRunsPath } from "../infra/config-paths"

export function readRoutine(date: string): DailyRoutine | null {
  const path = getRoutineSchedulePath(date)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DailyRoutine
  } catch {
    return null
  }
}

export function writeRoutine(routine: DailyRoutine): void {
  const path = getRoutineSchedulePath(routine.date)
  writeFileSync(path, JSON.stringify(routine, null, 2), "utf-8")
}

export function updateEntryStatus(
  date: string,
  entryId: string,
  status: RoutineEntryStatus,
  result?: { summary: string; relatedIds?: string[] }
): DailyRoutine | null {
  const routine = readRoutine(date)
  if (!routine) return null
  const entry = routine.entries.find((e) => e.id === entryId)
  if (!entry) return null
  entry.status = status
  if (result) {
    entry.result = result
  }
  routine.status = deriveRoutineStatus(routine.entries)
  writeRoutine(routine)
  return routine
}

export function updateRoutineStatus(date: string, status: RoutineStatus): DailyRoutine | null {
  const routine = readRoutine(date)
  if (!routine) return null
  routine.status = status
  writeRoutine(routine)
  return routine
}

export function appendRoutineRun(record: { entryId: string; activity: string; status: string; completedAt: number }): void {
  const path = getRoutineRunsPath()
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8")
}

function deriveRoutineStatus(entries: { status: RoutineEntryStatus }[]): RoutineStatus {
  if (entries.every((e) => e.status === "completed" || e.status === "skipped" || e.status === "failed")) {
    return "completed"
  }
  if (entries.some((e) => e.status === "running")) {
    return "running"
  }
  return "planned"
}
