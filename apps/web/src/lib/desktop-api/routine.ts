import type { DailyRoutine } from "@lume/shared"
import { ROUTINE_IPC_CHANNELS } from "@lume/shared"
import { sidecarCall } from "./system"

export const getRoutineToday = () =>
  sidecarCall<DailyRoutine | null>(ROUTINE_IPC_CHANNELS.GET_TODAY)

export const getRoutineByDate = (date: string) =>
  sidecarCall<DailyRoutine | null>(ROUTINE_IPC_CHANNELS.GET_BY_DATE, { date })

export const triggerRoutineEntry = (entryId: string) =>
  sidecarCall<DailyRoutine | null>(ROUTINE_IPC_CHANNELS.TRIGGER_ENTRY, { entryId })

export const regenerateRoutine = () =>
  sidecarCall<DailyRoutine>(ROUTINE_IPC_CHANNELS.REGENERATE)
