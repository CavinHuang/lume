import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs"
import type { DailyRoutine, RoutineEntryStatus, RoutineStatus, AutomationRun, AgentMessage, SDKMessage } from "@lume/shared"
import { getRoutineSchedulePath, getRoutineRunsPath, getAutomationRunsPath, getAgentThreadMessagesPath } from "../infra/config-paths"
import { getAgentThreadMessages, getAgentThreadSDKMessages } from "../agent/agent-thread-manager"
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
    // 原子写(#518)：直写被崩溃截断后 readRoutine 返回 null，runner 整日重生成
    // 并丢失 automationJobId 绑定、index 残留孤儿 once-job
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmpPath, JSON.stringify(routine, null, 2), "utf-8")
    renameSync(tmpPath, path)
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
      // Also check sdkMessages for text content (tool-use turns may have no plain text)
      const sdkText = extractTextFromSdkMessages(msg.sdkMessages)
      if (sdkText) {
        return sdkText
      }
    }

    // Fallback: read raw SDK messages from the session jsonl file
    // This handles cases where the version store hasn't captured the assistant turn yet
    const sdkMessages = getAgentThreadSDKMessages(threadId)
    const sdkText = extractTextFromSdkMessages(sdkMessages)
    if (sdkText) {
      return sdkText
    }
  } catch {
    // Thread may not be accessible; fall back to undefined
  }
  return undefined
}

function extractTextFromSdkMessages(sdkMessages: SDKMessage[] | undefined): string | undefined {
  if (!Array.isArray(sdkMessages) || sdkMessages.length === 0) return undefined
  // Walk backwards through SDK messages, find last assistant message with text
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i]!
    if (msg.type !== "assistant") continue
    const content = (msg as { message?: { content?: unknown[] } }).message?.content
    if (!Array.isArray(content)) continue
    const textParts: string[] = []
    for (const part of content) {
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
        const text = (part as Record<string, string>).text
        if (typeof text === "string" && text.trim()) {
          textParts.push(text.trim())
        }
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n")
    }
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
