import type { DailyRoutine, RoutineEntryStatus, RoutineResult } from "@lume/shared"
import { createAutomationJob, setAutomationJobProvenance } from "../automation/automation-manager"
import { listAutomationJobs } from "../automation/automation-manager"
import { startAutomationRunner, refreshAutomationRunnerJobs } from "../automation/automation-runner-service"
import { getActivityExecutor } from "./routine-activities"
import { readRoutine, writeRoutine, appendRoutineRun, listAutomationRunsForJob, getLatestAssistantResponse } from "./routine-store"
import { createLogger } from "../infra/logger"

import { localDateKey } from "./routine-date"
const log = createLogger("routine")

function today(): string {
  // 本地时区日期键，替代 UTC toISOString 键（#408）
  return localDateKey()
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
        const job = createAutomationJob({ ...jobInput, source: "system", systemAction: "routine" })
        if (entry.activity === "todo_review") setAutomationJobProvenance(job.id, { kind: "routine_todo_review", routineId: routine.id, activityId: entry.id })
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
          source: "system",
          systemAction: "routine",
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
    const job = createAutomationJob({ ...jobInput, source: "system", systemAction: "routine" })
    if (entry.activity === "todo_review") setAutomationJobProvenance(job.id, { kind: "routine_todo_review", routineId: routine.id, activityId: entry.id })
    entry.automationJobId = job.id
  } else if (entry.customPrompt) {
    // Custom activity: use customPrompt
    const job = createAutomationJob({
      name: entry.customName ?? entry.activity,
      prompt: entry.customPrompt,
      schedule: { type: "once", runAt: Date.now() },
      enabled: true,
      source: "system",
      systemAction: "routine",
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

/**
 * 根据自动化 job 与最近一次 run 判定 routine 条目的完成状态。
 * job 未跑完（仍 enabled 或无 lastRunAt）返回 null（不更新）；
 * run 失败 → failed；否则 → completed（summary 优先用 LLM 回复，回退 run 消息）。
 */
export function resolveRoutineEntryCompletion(input: {
  job: { enabled: boolean; lastRunAt?: number }
  latestRun?: { status?: string; message?: string; threadId?: string }
  llmReply?: string
}): { status: RoutineEntryStatus; result?: RoutineResult } | null {
  const { job, latestRun, llmReply } = input
  if (job.enabled || !job.lastRunAt) {
    return null
  }
  // skipped 表示「任务仍在运行，已跳过本次触发」——并未真正执行，不能当作完成。
  // （once 任务卡在 runningJobs 时，曾被 listAutomationRunsForJob 按 startedAt 误判为
  // latest run，进而被这里标成 completed，导致条目显示「已完成」但 result 是 skip 文案。）
  if (latestRun?.status === "skipped") {
    return null
  }
  if (latestRun?.status === "failed") {
    return {
      status: "failed",
      result: { summary: latestRun.message ?? "任务执行失败" },
    }
  }
  const summary = llmReply ?? latestRun?.message
  return {
    status: "completed",
    ...(summary ? { result: { summary } } : {}),
  }
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
      const runs = listAutomationRunsForJob(entry.automationJobId, 1)
      const latestRun = runs[0]
      const llmReply = latestRun?.threadId
        ? getLatestAssistantResponse(latestRun.threadId)
        : undefined
      const completion = resolveRoutineEntryCompletion({ job, latestRun, llmReply })
      if (!completion) continue
      entry.status = completion.status
      if (completion.result) {
        entry.result = completion.result
      }
      changed++
      if (completion.status === "failed") {
        log.warn("条目执行失败", { date, entryId: entry.id, activity: entry.activity, runStatus: latestRun?.status })
      } else {
        log.info("条目执行完成", { date, entryId: entry.id, activity: entry.activity, runStatus: latestRun?.status })
      }
      appendRoutineRun({
        entryId: entry.id,
        activity: entry.activity,
        status: completion.status,
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
