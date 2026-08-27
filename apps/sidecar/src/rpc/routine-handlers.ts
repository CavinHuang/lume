import { ROUTINE_IPC_CHANNELS } from "@lume/shared"
import { routineGetByDateInputSchema, routineTriggerEntryInputSchema } from "./schemas"
import type { RpcHandler } from "./types"
import { validateInput } from "./validation"
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
      const input = validateInput(routineGetByDateInputSchema, params, ROUTINE_IPC_CHANNELS.GET_BY_DATE)
      syncRoutineStatus()
      return readRoutine(input.date)
    },

    [ROUTINE_IPC_CHANNELS.TRIGGER_ENTRY]: async (params) => {
      const input = validateInput(routineTriggerEntryInputSchema, params, ROUTINE_IPC_CHANNELS.TRIGGER_ENTRY)
      log.info("RPC: 手动触发条目", { entryId: input.entryId })
      return triggerRoutineEntry(input.entryId)
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
