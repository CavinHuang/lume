import { generateDailyRoutine } from "./routine-generator"
import { scheduleRoutineEntries } from "./routine-executor"
import { syncRoutineStatus } from "./routine-executor"
import { readRoutine } from "./routine-store"

const ROUTINE_GENERATE_HOUR = 8
const SYNC_INTERVAL_MS = 5 * 60 * 1000

let generateTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let runnerStarted = false

function today(): string {
  return new Date().toISOString().slice(0, 10)
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
      console.error("[日程] 日程生成失败:", error instanceof Error ? error.message : String(error))
    }
    scheduleNextGeneration()
  }, delay)

  console.log(`[日程] 下次生成时间: ${target.toLocaleString("zh-CN")}`)
}

async function runDailyGeneration(): Promise<void> {
  console.log("[日程] 开始生成今日日程")
  const routine = await generateDailyRoutine()
  await scheduleRoutineEntries(routine)
  console.log(`[日程] 已生成 ${routine.entries.length} 个活动`)
}

export async function startRoutineRunner(): Promise<void> {
  if (runnerStarted) return
  runnerStarted = true

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
      console.error("[日程] 状态同步失败:", error instanceof Error ? error.message : String(error))
    }
  }, SYNC_INTERVAL_MS)
}

export function stopRoutineRunner(): void {
  runnerStarted = false
  if (generateTimer) {
    clearTimeout(generateTimer)
    generateTimer = null
  }
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}
