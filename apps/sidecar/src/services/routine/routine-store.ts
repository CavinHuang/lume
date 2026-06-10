import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import type { DailyRoutine, RoutineEntryStatus, RoutineStatus, AutomationRun, AgentMessage } from "@lume/shared"
import { getRoutineSchedulePath, getRoutineRunsPath, getAutomationRunsPath } from "../infra/config-paths"
import { getAgentThreadMessages } from "../agent/agent-thread-manager"
import { createLogger } from "../infra/logger"

const log = createLogger("routine")

export function readRoutine(date: string): DailyRoutine | null {
  const path = getRoutineSchedulePath(date)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DailyRoutine
  } catch (error) {
    log.warn("读取日程文件失败", { date, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export function writeRoutine(routine: DailyRoutine): void {
  const path = getRoutineSchedulePath(routine.date)
  try {
    writeFileSync(path, JSON.stringify(routine, null, 2), "utf-8")
  } catch (error) {
    log.error("写入日程文件失败", { date: routine.date, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
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
  log.info("更新条目状态", { date, entryId, activity: entry.activity, status })
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

function parseRunLine(line: string): AutomationRun | null {
  if (!line.trim()) return null
  try {
    return JSON.parse(line) as AutomationRun
  } catch {
    return null
  }
}

export function listAutomationRunsForJob(jobId: string, limit = 5): AutomationRun[] {
  const path = getAutomationRunsPath()
  if (!existsSync(path)) return []
  const lines = readFileSync(path, "utf-8").split("\n")
  const runs: AutomationRun[] = []
  for (const line of lines) {
    const run = parseRunLine(line)
    if (!run || run.jobId !== jobId) continue
    runs.push(run)
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

export function getLatestAssistantResponse(threadId: string): string | undefined {
  try {
    const messages = getAgentThreadMessages(threadId)
    // Walk backwards to find the last assistant message with text content
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (!msg || msg.role !== "assistant") continue
      if (msg.content?.trim()) {
        return msg.content.trim()
      }
    }
  } catch {
    // Thread may not be accessible; fall back to undefined
  }
  return undefined
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
