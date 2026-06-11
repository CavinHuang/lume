import type { DailyRoutine } from "@lume/shared"
import { createAutomationJob } from "../automation/automation-manager"
import { listAutomationJobs } from "../automation/automation-manager"
import { startAutomationRunner, refreshAutomationRunnerJobs } from "../automation/automation-runner-service"
import { getActivityExecutor } from "./routine-activities"
import { readRoutine, writeRoutine, appendRoutineRun, listAutomationRunsForJob, getLatestAssistantResponse } from "./routine-store"
import { createLogger } from "../infra/logger"

const log = createLogger("routine")

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function scheduleRoutineEntries(routine: DailyRoutine): Promise<DailyRoutine> {
  await startAutomationRunner()

  let scheduled = 0
  let failed = 0
  let skipped = 0

  for (const entry of routine.entries) {
    if (entry.status !== "pending" || entry.automationJobId) continue

    // Try predefined executor first
    const executor = getActivityExecutor(entry.activity)
    if (executor) {
      try {
        const jobInput = executor.buildJobInput(entry, routine.context)
        const job = createAutomationJob(jobInput)
        entry.automationJobId = job.id
        scheduled++
      } catch (error) {
        entry.status = "failed"
        failed++
        log.warn("调度条目失败", { entryId: entry.id, activity: entry.activity, error: error instanceof Error ? error.message : String(error) })
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
        scheduled++
      } catch (error) {
        entry.status = "failed"
        failed++
        log.warn("调度自定义条目失败", { entryId: entry.id, activity: entry.activity, error: error instanceof Error ? error.message : String(error) })
      }
      continue
    }

    // No executor and no custom prompt — skip
    entry.status = "skipped"
    skipped++
  }

  await refreshAutomationRunnerJobs()
  writeRoutine(routine)
  log.info("条目调度完成", { date: routine.date, scheduled, failed, skipped })
  return routine
}

export async function triggerRoutineEntry(entryId: string): Promise<DailyRoutine | null> {
  const date = today()
  const routine = readRoutine(date)
  if (!routine) return null

  const entry = routine.entries.find((e) => e.id === entryId)
  if (!entry) return null

  log.info("手动触发条目", { date, entryId, activity: entry.activity })

  // Reset status so syncRoutineStatus can track the new job
  entry.status = "pending"
  routine.status = "running"

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

  // Reset status so syncRoutineStatus picks up the new job
  entry.status = "pending"

  await refreshAutomationRunnerJobs()
  writeRoutine(routine)
  return routine
}

export function syncRoutineStatus(): void {
  const date = today()
  const routine = readRoutine(date)
  if (!routine) return

  const jobs = listAutomationJobs()
  let changed = 0

  for (const entry of routine.entries) {
    if (!entry.automationJobId) continue

    const job = jobs.find((j) => j.id === entry.automationJobId)
    if (!job) continue

    // Backfill result for completed entries that are missing it
    if (entry.status === "completed" && !entry.result) {
      const runs = listAutomationRunsForJob(entry.automationJobId, 1)
      const latestRun = runs[0]
      if (latestRun) {
        const llmReply = latestRun.threadId
          ? getLatestAssistantResponse(latestRun.threadId)
          : undefined
        entry.result = { summary: llmReply ?? latestRun.message }
        changed++
      }
      continue
    }

    if (entry.status === "completed") {
      // Try to upgrade fallback results to actual LLM responses
      if (entry.result?.summary?.startsWith("任务执行完成，线程:")) {
        const runs = listAutomationRunsForJob(entry.automationJobId, 1)
        const latestRun = runs[0]
        if (latestRun?.threadId) {
          const llmReply = getLatestAssistantResponse(latestRun.threadId)
          if (llmReply) {
            entry.result = { summary: llmReply }
            changed++
          }
        }
      }
      continue
    }

    if (!job.enabled && job.lastRunAt) {
      entry.status = "completed"
      // Get the LLM's reply from the agent thread, fall back to run log message
      const runs = listAutomationRunsForJob(entry.automationJobId, 1)
      const latestRun = runs[0]
      if (latestRun) {
        const llmReply = latestRun.threadId
          ? getLatestAssistantResponse(latestRun.threadId)
          : undefined
        entry.result = { summary: llmReply ?? latestRun.message }
      }
      changed++
      log.info("条目执行完成", { date, entryId: entry.id, activity: entry.activity, runStatus: latestRun?.status })
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
    log.info("日程全部完成", { date, totalEntries: routine.entries.length })
  } else if (routine.entries.some((e) => e.status === "running")) {
    routine.status = "running"
  }

  if (changed > 0 || allDone) {
    writeRoutine(routine)
  }
}
