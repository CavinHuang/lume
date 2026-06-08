import { ROUTINE_IPC_CHANNELS } from "@lume/shared"
import type { RpcHandler } from "./types"
import { readRoutine } from "../services/routine/routine-store"
import { generateDailyRoutine } from "../services/routine/routine-generator"
import { triggerRoutineEntry, syncRoutineStatus } from "../services/routine/routine-executor"

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function createRoutineHandlers(): Record<string, RpcHandler> {
  return {
    [ROUTINE_IPC_CHANNELS.GET_TODAY]: async () => {
      syncRoutineStatus()
      return readRoutine(today())
    },

    [ROUTINE_IPC_CHANNELS.TRIGGER_ENTRY]: async (params) => {
      const { entryId } = params as { entryId: string }
      if (!entryId) throw new Error("entryId 不能为空")
      return triggerRoutineEntry(entryId)
    },

    [ROUTINE_IPC_CHANNELS.REGENERATE]: async () => {
      const date = today()
      const routine = generateDailyRoutine(date)
      return routine
    },
  }
}
