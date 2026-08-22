import { generateDailyRoutine } from "./routine-generator"
import { scheduleRoutineEntries } from "./routine-executor"
import { syncRoutineStatus } from "./routine-executor"
import { readRoutine } from "./routine-store"
import { createLogger } from "../infra/logger"

import { localDateKey } from "./routine-date"
const log = createLogger("routine")

const ROUTINE_GENERATE_HOUR = 8
const SYNC_INTERVAL_MS = 5 * 60 * 1000

let generateTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let runnerStarted = false

function today(): string {
  // 本地时区日期键，替代 UTC toISOString 键（#408）
  return localDateKey()
}

function scheduleNextGeneration(): void {
  if (generateTimer) {
    clearTimeout(generateTimer)
    generateTimer = null
  }

  const now = new Date()
  const target = new Date(now)
  target.setHours(ROUTINE_GENERATE_HOUR, 0, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  const delay = target.getTime() - now.getTime()

  generateTimer = setTimeout(async () => {
    try {
      await runDailyGeneration()
    } catch (error) {
      log.error("日程生成失败", { error: error instanceof Error ? error.message : String(error) })
    }
    scheduleNextGeneration()
  }, delay)

  log.info("已调度下次生成", { target: target.toLocaleString("zh-CN") })
}

async function runDailyGeneration(): Promise<void> {
  log.info("开始生成今日日程")
  const routine = await generateDailyRoutine()
  await scheduleRoutineEntries(routine)
  log.info("今日日程已生成并调度", { totalEntries: routine.entries.length })
}

export async function startRoutineRunner(): Promise<void> {
  if (runnerStarted) return
  runnerStarted = true

  log.info("日程运行器启动")

  const date = today()
  const existing = readRoutine(date)
  if (!existing) {
    await runDailyGeneration()
  } else if (existing.status === "planned") {
    await scheduleRoutineEntries(existing)
  }

  scheduleNextGeneration()

  syncTimer = setInterval(() => {
    try {
      syncRoutineStatus()
    } catch (error) {
      log.error("状态同步失败", { error: error instanceof Error ? error.message : String(error) })
    }
  }, SYNC_INTERVAL_MS)
}

export function stopRoutineRunner(): void {
  runnerStarted = false
  log.info("日程运行器停止")
  if (generateTimer) {
    clearTimeout(generateTimer)
    generateTimer = null
  }
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}
