import type { DailyRoutine } from "@lume/shared"
import { createAutomationJob, listAutomationJobs } from "../automation/automation-manager"
import { startAutomationRunner, refreshAutomationRunnerJobs } from "../automation/automation-runner-service"
import { getActivityExecutor } from "./routine-activities"
import { readRoutine, writeRoutine, appendRoutineRun } from "./routine-store"

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function scheduleRoutineEntries(routine: DailyRoutine): Promise<DailyRoutine> {
  await startAutomationRunner()

  for (const entry of routine.entries) {
    if (entry.status !== "pending" || entry.automationJobId) continue

    const executor = getActivityExecutor(entry.activity)
    if (!executor) {
      entry.status = "skipped"
      continue
    }

    try {
      const jobInput = executor.buildJobInput(entry, routine.context)
      const job = createAutomationJob(jobInput)
      entry.automationJobId = job.id
    } catch {
      entry.status = "failed"
    }
  }

  await refreshAutomationRunnerJobs()
  writeRoutine(routine)
  return routine
}

export async function triggerRoutineEntry(entryId: string): Promise<DailyRoutine | null> {
  const date = today()
  const routine = readRoutine(date)
  if (!routine) return null

  const entry = routine.entries.find((e) => e.id === entryId)
  if (!entry) return null

  const executor = getActivityExecutor(entry.activity)
  if (!executor) return null

  const jobInput = executor.buildJobInput({ ...entry, scheduledAt: Date.now() }, routine.context)
  const job = createAutomationJob(jobInput)
  entry.automationJobId = job.id

  await refreshAutomationRunnerJobs()
  writeRoutine(routine)
  return routine
}

export function syncRoutineStatus(): void {
  const date = today()
  const routine = readRoutine(date)
  if (!routine || routine.status === "completed") return

  const jobs = listAutomationJobs()

  for (const entry of routine.entries) {
    if (!entry.automationJobId || entry.status === "completed" || entry.status === "failed") continue

    const job = jobs.find((j) => j.id === entry.automationJobId)
    if (!job) continue

    if (!job.enabled && job.lastRunAt) {
      entry.status = "completed"
      appendRoutineRun({
        entryId: entry.id,
        activity: entry.activity,
        status: "completed",
        completedAt: Date.now(),
      })
    }
  }

  const allDone = routine.entries.every(
    (e) => e.status === "completed" || e.status === "skipped" || e.status === "failed"
  )
  if (allDone) {
    routine.status = "completed"
  } else if (routine.entries.some((e) => e.status === "running")) {
    routine.status = "running"
  }

  writeRoutine(routine)
}
