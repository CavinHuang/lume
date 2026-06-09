import type { DailyRoutine } from "@lume/shared"
import { createAutomationJob } from "../automation/automation-manager"
import { listAutomationJobs } from "../automation/automation-manager"
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

    // Try predefined executor first
    const executor = getActivityExecutor(entry.activity)
    if (executor) {
      try {
        const jobInput = executor.buildJobInput(entry, routine.context)
        const job = createAutomationJob(jobInput)
        entry.automationJobId = job.id
      } catch {
        entry.status = "failed"
      }
      continue
    }

    // Custom activity: use customPrompt from the entry
    if (entry.customPrompt) {
      try {
        const job = createAutomationJob({
          name: entry.customName ?? entry.activity,
          prompt: entry.customPrompt,
          schedule: { type: "once", runAt: entry.scheduledAt },
          enabled: true,
        })
        entry.automationJobId = job.id
      } catch {
        entry.status = "failed"
      }
      continue
    }

    // No executor and no custom prompt — skip
    entry.status = "skipped"
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

  // Try predefined executor first
  const executor = getActivityExecutor(entry.activity)
  if (executor) {
    const jobInput = executor.buildJobInput({ ...entry, scheduledAt: Date.now() }, routine.context)
    const job = createAutomationJob(jobInput)
    entry.automationJobId = job.id
  } else if (entry.customPrompt) {
    // Custom activity: use customPrompt
    const job = createAutomationJob({
      name: entry.customName ?? entry.activity,
      prompt: entry.customPrompt,
      schedule: { type: "once", runAt: Date.now() },
      enabled: true,
    })
    entry.automationJobId = job.id
  } else {
    return null
  }

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
