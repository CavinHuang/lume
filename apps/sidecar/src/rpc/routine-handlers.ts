import { ROUTINE_IPC_CHANNELS } from "@lume/shared"
import type { RpcHandler } from "./types"
import { readRoutine } from "../services/routine/routine-store"
import { generateDailyRoutine } from "../services/routine/routine-generator"
import { triggerRoutineEntry, scheduleRoutineEntries, syncRoutineStatus } from "../services/routine/routine-executor"
import { localDateKey } from "../services/routine/routine-date"
import { createLogger } from "../services/infra/logger"

const log = createLogger("routine-rpc")

function today(): string {
  // 本地时区日期键，与 runner/generator 同域；UTC 键会让当地晚间读空、
  // 晨间 REGENERATE 写到昨日文件（#408/#451）
  return localDateKey()
}

export function createRoutineHandlers(): Record<string, RpcHandler> {
  return {
    [ROUTINE_IPC_CHANNELS.GET_TODAY]: async () => {
      syncRoutineStatus()
      return readRoutine(today())
    },

    [ROUTINE_IPC_CHANNELS.GET_BY_DATE]: async (params) => {
      const { date } = params as { date: string }
      if (!date) throw new Error("date 不能为空")
      syncRoutineStatus()
      return readRoutine(date)
    },

    [ROUTINE_IPC_CHANNELS.TRIGGER_ENTRY]: async (params) => {
      const { entryId } = params as { entryId: string }
      if (!entryId) throw new Error("entryId 不能为空")
      log.info("RPC: 手动触发条目", { entryId })
      return triggerRoutineEntry(entryId)
    },

    [ROUTINE_IPC_CHANNELS.REGENERATE]: async () => {
      const date = today()
      log.info("RPC: 重新生成日程", { date })
      const routine = await generateDailyRoutine(date, true)
      await scheduleRoutineEntries(routine)
      return routine
    },
  }
}
