import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SubagentRun, SubagentSession, SubagentTask, SubagentTaskFeedback } from '@lume/shared'
import { getAgentConfigDir } from '../../infra/config-paths'

export const SUBAGENT_WORK_STORE_VERSION = 2 as const
const STORE_FILE = 'subagent-runs.json'
const RESTART_ERROR = 'Sidecar 进程重启，之前的进程内 subagent 已退出。'
const TERMINAL_RUN_STATUSES = new Set<SubagentRun['status']>(['completed', 'errored', 'cancelled', 'timed_out'])

export interface SubagentWorkStoreSnapshot {
  version: typeof SUBAGENT_WORK_STORE_VERSION
  sessions: SubagentSession[]
  tasks: SubagentTask[]
  feedback: SubagentTaskFeedback[]
  runs: SubagentRun[]
}

type LegacyRun = {
  runId?: unknown; parentThreadId?: unknown; parentRunId?: unknown; childThreadId?: unknown
  task?: unknown; label?: unknown; requestedAgentId?: unknown; resolvedAgentId?: unknown
  status?: unknown; createdAt?: unknown; updatedAt?: unknown; startedAt?: unknown; endedAt?: unknown
  outcome?: unknown
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

function nowNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function defaultSnapshot(): SubagentWorkStoreSnapshot {
  return { version: SUBAGENT_WORK_STORE_VERSION, sessions: [], tasks: [], feedback: [], runs: [] }
}

export class SubagentWorkStore {
  private initialized = false
  constructor(private readonly filePath = getSubagentWorkStorePath()) {}

  snapshot(): SubagentWorkStoreSnapshot {
    const normalized = this.readAndNormalize()
    return clone(normalized)
  }

  load(): SubagentWorkStoreSnapshot { return this.snapshot() }

  replace(snapshot: SubagentWorkStoreSnapshot): SubagentWorkStoreSnapshot {
    const normalized = normalizeV2(snapshot as unknown as Record<string, unknown>)
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
    this.initialized = true
    return clone(normalized)
  }

  save(snapshot: SubagentWorkStoreSnapshot): SubagentWorkStoreSnapshot { return this.replace(snapshot) }
  findSession(subagentId: string): SubagentSession | undefined { return this.snapshot().sessions.find((item) => item.subagentId === subagentId) }
  findTask(taskId: string): SubagentTask | undefined { return this.snapshot().tasks.find((item) => item.taskId === taskId) }
  findRun(runId: string): SubagentRun | undefined { return this.snapshot().runs.find((item) => item.runId === runId) }

  private readAndNormalize(): SubagentWorkStoreSnapshot {
    if (!existsSync(this.filePath)) return defaultSnapshot()
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.filePath, 'utf8')) } catch { return defaultSnapshot() }
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const snapshot = record.version === SUBAGENT_WORK_STORE_VERSION
      ? normalizeV2(record)
      : migrateLegacy(record)
    const normalized = this.initialized ? snapshot : repairAfterRestart(snapshot)
    this.initialized = true
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) this.replace(normalized)
    return normalized
  }
}

function normalizeV2(raw: Record<string, unknown>): SubagentWorkStoreSnapshot {
  const now = Date.now()
  const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(isSession).map(clone) : []
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter(isTask).map(clone) : []
  const feedback = Array.isArray(raw.feedback) ? raw.feedback.filter(isFeedback).map(clone) : []
  const runs = Array.isArray(raw.runs) ? raw.runs.filter(isRun).map(clone) : []
  return {
    version: SUBAGENT_WORK_STORE_VERSION,
    sessions,
    tasks,
    feedback,
    runs: runs.map((run) => ({
      ...run,
      ...(Array.isArray(run.runtimeRunIds)
        ? { runtimeRunIds: run.runtimeRunIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) }
        : {}),
      updatedAt: nowNumber(run.updatedAt, now),
    })),
  }
}

function migrateLegacy(raw: Record<string, unknown>): SubagentWorkStoreSnapshot {
  const legacyRuns = Array.isArray(raw.runs) ? raw.runs as LegacyRun[] : []
  const snapshot = defaultSnapshot()
  const sessions = new Set<string>()
  for (const legacy of legacyRuns) {
    const runId = readString(legacy.runId)
    const parentThreadId = readString(legacy.parentThreadId)
    const childThreadId = readString(legacy.childThreadId)
    const objective = readString(legacy.task) ?? readString(legacy.label)
    if (!runId || !parentThreadId || !childThreadId || !objective) continue
    const createdAt = nowNumber(legacy.createdAt, Date.now())
    const subagentId = `legacy:${childThreadId}`
    const taskId = `legacy-task:${runId}`
    const oldStatus = readString(legacy.status)
    const status: SubagentRun['status'] = oldStatus === 'completed' ? 'completed'
      : oldStatus === 'timed_out' ? 'timed_out'
      : oldStatus === 'canceled' || oldStatus === 'aborted' ? 'cancelled'
      : oldStatus === 'errored' ? 'errored' : 'errored'
    if (!sessions.has(subagentId)) {
      sessions.add(subagentId)
      snapshot.sessions.push({ subagentId, threadId: childThreadId, parentThreadId, agentType: readString(legacy.resolvedAgentId) ?? readString(legacy.requestedAgentId) ?? 'general-purpose', title: readString(legacy.label) ?? objective.slice(0, 80), status: 'idle', createdAt, lastUsedAt: createdAt })
    }
    snapshot.tasks.push({ taskId, subagentId, parentThreadId, parentRunId: readString(legacy.parentRunId) ?? runId, objective, acceptanceCriteria: [], status: status === 'completed' ? 'accepted' : 'awaiting_review', attemptCount: 1, createdAt, updatedAt: nowNumber(legacy.updatedAt, createdAt), ...(status === 'completed' ? { resolvedAt: nowNumber(legacy.endedAt, createdAt) } : {}) })
    const outcome = legacy.outcome && typeof legacy.outcome === 'object' ? legacy.outcome as Record<string, unknown> : {}
    snapshot.runs.push({ runId, taskId, subagentId, childThreadId, parentThreadId, parentRunId: readString(legacy.parentRunId) ?? runId, parentToolUseId: readString(legacy.parentRunId) ?? `legacy-tool:${runId}`, attempt: 1, instruction: objective, status, createdAt, updatedAt: nowNumber(legacy.updatedAt, createdAt), ...(typeof legacy.startedAt === 'number' ? { startedAt: legacy.startedAt } : {}), ...(typeof legacy.endedAt === 'number' ? { endedAt: legacy.endedAt } : {}), ...(status === 'completed' ? { report: { status: 'submitted' as const, summary: readString(outcome.output) ?? objective } } : {}), ...(status !== 'completed' ? { error: readString(outcome.error) ?? RESTART_ERROR } : {}) })
  }
  return snapshot
}

function repairAfterRestart(snapshot: SubagentWorkStoreSnapshot): SubagentWorkStoreSnapshot {
  const now = Date.now()
  const activeTaskIds = new Set<string>()
  const runs = snapshot.runs.map((run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run
    activeTaskIds.add(run.taskId)
    return { ...run, status: 'errored' as const, error: run.error ?? RESTART_ERROR, endedAt: run.endedAt ?? now, updatedAt: now }
  })
  const tasks = snapshot.tasks.map((task) => activeTaskIds.has(task.taskId)
    ? { ...task, status: 'awaiting_review' as const, updatedAt: now }
    : task)
  const busyIds = new Set(runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status)).map((run) => run.subagentId))
  const sessions = snapshot.sessions.map((session) => session.status === 'busy' && !busyIds.has(session.subagentId)
    ? { ...session, status: 'idle' as const, currentRunId: undefined, currentTaskId: undefined }
    : session)
  return { version: SUBAGENT_WORK_STORE_VERSION, sessions, tasks, feedback: snapshot.feedback, runs }
}

function isSession(value: unknown): value is SubagentSession { const item = value as SubagentSession; return !!item && typeof item.subagentId === 'string' && typeof item.threadId === 'string' && typeof item.parentThreadId === 'string' }
function isTask(value: unknown): value is SubagentTask { const item = value as SubagentTask; return !!item && typeof item.taskId === 'string' && typeof item.subagentId === 'string' && typeof item.parentThreadId === 'string' }
function isFeedback(value: unknown): value is SubagentTaskFeedback { const item = value as SubagentTaskFeedback; return !!item && typeof item.taskId === 'string' && typeof item.instruction === 'string' && typeof item.attempt === 'number' }
function isRun(value: unknown): value is SubagentRun { const item = value as SubagentRun; return !!item && typeof item.runId === 'string' && typeof item.taskId === 'string' && typeof item.subagentId === 'string' && typeof item.childThreadId === 'string' }

export function getSubagentWorkStorePath(): string { return join(getAgentConfigDir(), STORE_FILE) }
let singleton: SubagentWorkStore | undefined
export function getSubagentWorkStore(): SubagentWorkStore { return singleton ??= new SubagentWorkStore() }
export function resetSubagentWorkStoreForTest(): void { singleton = undefined }
