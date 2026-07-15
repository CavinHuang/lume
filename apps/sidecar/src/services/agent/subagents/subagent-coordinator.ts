import { randomUUID } from 'node:crypto'
import type { AgentToolResult, SubagentRun, SubagentRunLink, SubagentSession, SubagentTask, SubagentTaskFeedback, SubagentTaskReport } from '@lume/shared'
import { getSubagentWorkStore, type SubagentWorkStore, type SubagentWorkStoreSnapshot } from './subagent-work-store'

const MAX_CONCURRENT_SUBAGENTS = 4
const TERMINAL = new Set<SubagentRun['status']>(['completed', 'errored', 'cancelled', 'timed_out'])

export interface CoordinatorExecutionInput {
  session: SubagentSession
  task: SubagentTask
  run: SubagentRun
  feedback: SubagentTaskFeedback[]
  signal: AbortSignal
}

export interface CoordinatorExecutionResult {
  status?: Extract<SubagentRun['status'], 'completed' | 'errored' | 'cancelled' | 'timed_out'>
  error?: string
  completionSummary?: string
}

export interface RunAgentTaskInput {
  parentThreadId: string
  parentRunId: string
  parentToolUseId: string
  prompt: string
  description: string
  subagentType?: string
  subagentId?: string
  taskId?: string
  acceptanceCriteria?: string[]
  expectedArtifacts?: string[]
  /** Called only when a new reusable child thread is needed. */
  createSession: (input: { subagentId: string; title: string; agentType: string }) => Pick<SubagentSession, 'threadId' | 'modelRef'>
  execute: (input: CoordinatorExecutionInput) => Promise<CoordinatorExecutionResult>
}

export interface SubagentWorkSnapshot extends SubagentWorkStoreSnapshot { links: SubagentRunLink[] }

export type SubagentWorkChangeListener = (input: { parentThreadId: string; subagentId?: string; taskId?: string; runId?: string; updatedAt: number }) => void

export class SubagentCoordinator {
  private readonly sessionTails = new Map<string, Promise<unknown>>()
  private readonly aborts = new Map<string, AbortController>()
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly listeners = new Set<SubagentWorkChangeListener>()

  constructor(private readonly store: SubagentWorkStore = getSubagentWorkStore()) {}

  subscribe(listener: SubagentWorkChangeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  list(parentThreadId: string): SubagentWorkSnapshot {
    const state = this.store.snapshot()
    const sessions = state.sessions.filter((item) => item.parentThreadId === parentThreadId)
    const sessionIds = new Set(sessions.map((item) => item.subagentId))
    const tasks = state.tasks.filter((item) => item.parentThreadId === parentThreadId)
    const taskIds = new Set(tasks.map((item) => item.taskId))
    const runs = state.runs.filter((item) => taskIds.has(item.taskId))
    return { version: state.version, sessions, tasks, feedback: state.feedback.filter((item) => taskIds.has(item.taskId)), runs, links: runs.map(toLink) }
  }

  async runAgentTask(input: RunAgentTaskInput): Promise<AgentToolResult> {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('Agent prompt 不能为空')
    const created = this.createWork(input, prompt)
    const previous = this.sessionTails.get(created.session.subagentId) ?? Promise.resolve()
    const scheduled = previous.catch(() => undefined).then(() => this.withPermit(() => this.executeRun(created.run.runId, input.execute)))
    this.sessionTails.set(created.session.subagentId, scheduled.finally(() => {
      if (this.sessionTails.get(created.session.subagentId) === scheduled) this.sessionTails.delete(created.session.subagentId)
    }))
    return scheduled as Promise<AgentToolResult>
  }

  bindRuntimeRun(runId: string, runtimeRunId: string): SubagentRun {
    const normalized = runtimeRunId.trim()
    if (!normalized) throw new Error('runtimeRunId 不能为空')
    let changed = false
    const run = this.mutate((state) => {
      const found = required(state.runs.find((item) => item.runId === runId), '找不到 subagent Run')
      const ids = found.runtimeRunIds ?? []
      if (!ids.includes(normalized)) {
        found.runtimeRunIds = [...ids, normalized]
        found.updatedAt = Date.now()
        changed = true
      }
      return clone(found)
    })
    if (changed) this.notify(run.parentThreadId, undefined, undefined, run)
    return run
  }

  submitReport(input: { runId: string; report: SubagentTaskReport }): SubagentRun {
    const run = this.mutate((state) => {
      const found = state.runs.find((item) => item.runId === input.runId)
      if (!found) throw new Error('找不到当前 subagent Run')
      if (TERMINAL.has(found.status)) throw new Error('已结束的 subagent Run 不能再次提交报告')
      found.report = normalizeReport(input.report)
      found.updatedAt = Date.now()
      return clone(found)
    })
    this.notify(run.parentThreadId, undefined, undefined, run)
    return run
  }

  finishTask(input: { taskId: string; resolution: 'accepted' | 'deferred' | 'cancelled'; reason: string }): SubagentTask {
    const task = this.mutate((state) => {
      const task = state.tasks.find((item) => item.taskId === input.taskId)
      if (!task) throw new Error('找不到 subagent Task')
      if (task.status !== 'awaiting_review' && task.status !== 'open') throw new Error('只有待验收或开放任务可以结束')
      const now = Date.now()
      task.status = input.resolution
      task.updatedAt = now
      task.resolvedAt = now
      state.feedback.push({ taskId: task.taskId, attempt: task.attemptCount, instruction: input.reason.trim(), createdAt: now })
      return clone(task)
    })
    this.notify(task.parentThreadId, undefined, task)
    return task
  }

  retireSession(input: { subagentId: string; reason: string }): SubagentSession {
    const session = this.mutate((state) => {
      const session = state.sessions.find((item) => item.subagentId === input.subagentId)
      if (!session) throw new Error('找不到 subagent Session')
      if (session.status !== 'idle') throw new Error('busy Session 必须先等待或取消当前 Run 才能退休')
      session.status = 'retired'; session.retiredAt = Date.now(); session.currentRunId = undefined; session.currentTaskId = undefined
      return clone(session)
    })
    this.notify(session.parentThreadId, session)
    return session
  }

  async cancelByParentThread(parentThreadId: string, reason = '父会话已停止，子代理运行已取消。'): Promise<void> {
    const active = this.store.snapshot().runs.filter((run) => run.parentThreadId === parentThreadId && !TERMINAL.has(run.status))
    for (const run of active) this.aborts.get(run.runId)?.abort(reason)
    this.mutate((state) => {
      const now = Date.now()
      for (const run of state.runs) {
        if (run.parentThreadId !== parentThreadId || TERMINAL.has(run.status)) continue
        run.status = 'cancelled'; run.error = reason; run.endedAt = now; run.updatedAt = now
        const task = state.tasks.find((item) => item.taskId === run.taskId)
        if (task && task.status === 'running') { task.status = 'awaiting_review'; task.updatedAt = now }
        const session = state.sessions.find((item) => item.subagentId === run.subagentId)
        if (session?.status === 'busy') { session.status = 'idle'; session.currentRunId = undefined; session.currentTaskId = undefined }
      }
    })
    this.notify(parentThreadId)
  }

  async cancelAll(reason = 'Sidecar 正在退出，子代理运行已取消。'): Promise<void> {
    const parents = [...new Set(this.store.snapshot().runs
      .filter((run) => !TERMINAL.has(run.status))
      .map((run) => run.parentThreadId))]
    await Promise.all(parents.map((parentThreadId) => this.cancelByParentThread(parentThreadId, reason)))
  }

  getCompletionBlocker(parentThreadId: string, _parentRunId: string): string | undefined {
    const state = this.store.snapshot()
    const running = state.runs.filter((run) => run.parentThreadId === parentThreadId && !TERMINAL.has(run.status))
    if (running.length) return `仍有 ${running.length} 个 Subagent Run 正在执行。请等待 Agent 工具返回后再继续。`
    const review = state.tasks.filter((task) => task.parentThreadId === parentThreadId && task.status === 'awaiting_review')
    if (review.length) return `以下子代理任务等待你的验收决策：${review.map((task) => task.taskId).join(', ')}。请继续同一 task_id、调用 FinishAgentTask，或改派；不要直接生成最终答复。`
    return undefined
  }

  getRunCompletionBlocker(runId: string): string | undefined {
    const run = this.store.snapshot().runs.find((item) => item.runId === runId)
    if (!run || TERMINAL.has(run.status) || run.report) return undefined
    return '当前绑定的 Subagent Run 尚未提交 TaskReport。不要重复正文；请立即调用 TaskReport，提交 status 和 summary 后再结束。'
  }

  private createWork(input: RunAgentTaskInput, prompt: string): { session: SubagentSession; task: SubagentTask; run: SubagentRun } {
    return this.mutate((state) => {
      const now = Date.now()
      const requestedSubagentId = input.subagentId?.trim() || undefined
      let task = input.taskId ? state.tasks.find((item) => item.taskId === input.taskId) : undefined
      let session = requestedSubagentId ? state.sessions.find((item) => item.subagentId === requestedSubagentId) : undefined
      if (task) {
        if (task.parentThreadId !== input.parentThreadId) throw new Error('task_id 不属于当前父会话')
        if (session && session.subagentId !== task.subagentId) {
          task.subagentId = session.subagentId
          task.updatedAt = now
        } else session = state.sessions.find((item) => item.subagentId === task!.subagentId)
      }
      if (!session) {
        const subagentId = requestedSubagentId ?? randomUUID()
        const created = input.createSession({ subagentId, title: `${input.subagentType ?? 'general-purpose'} · ${input.description || prompt.slice(0, 48)}`, agentType: input.subagentType ?? 'general-purpose' })
        session = { subagentId, threadId: created.threadId, parentThreadId: input.parentThreadId, agentType: input.subagentType ?? 'general-purpose', ...(created.modelRef ? { modelRef: created.modelRef } : {}), title: `${input.subagentType ?? 'general-purpose'} · ${input.description || prompt.slice(0, 48)}`, status: 'idle', createdAt: now, lastUsedAt: now }
        state.sessions.push(session)
      }
      if (session.parentThreadId !== input.parentThreadId) throw new Error('subagent_id 不属于当前父会话')
      if (session.status === 'retired') throw new Error('已退休的 Subagent 不能接收新 Run')
      if (!task) {
        task = { taskId: randomUUID(), subagentId: session.subagentId, parentThreadId: input.parentThreadId, parentRunId: input.parentRunId, objective: prompt, acceptanceCriteria: input.acceptanceCriteria ?? [], ...(input.expectedArtifacts?.length ? { expectedArtifacts: input.expectedArtifacts } : {}), status: 'open', attemptCount: 0, createdAt: now, updatedAt: now }
        state.tasks.push(task)
      }
      if (task.status === 'accepted' || task.status === 'deferred' || task.status === 'cancelled') throw new Error('已结束的 Task 不能继续；请创建新任务')
      if (task.attemptCount > 0) {
        if (task.stalled && prompt === task.objective) {
          throw new Error('该 Task 连续报告没有实质变化；请提供不同的反馈或改派给其他 Subagent。')
        }
        state.feedback.push({ taskId: task.taskId, attempt: task.attemptCount + 1, instruction: prompt, createdAt: now })
      }
      const sameTurnAttempts = state.runs.filter((run) => run.taskId === task!.taskId && run.parentRunId === input.parentRunId).length
      if (sameTurnAttempts >= 3) throw new Error('同一 Task 在单次父 Run 中最多连续返工 3 次；请改派、defer 或说明新的策略。')
      task.attemptCount += 1; task.status = 'running'; task.updatedAt = now; task.parentRunId = input.parentRunId
      const run: SubagentRun = { runId: randomUUID(), taskId: task.taskId, subagentId: session.subagentId, childThreadId: session.threadId, parentThreadId: input.parentThreadId, parentRunId: input.parentRunId, parentToolUseId: input.parentToolUseId, attempt: task.attemptCount, instruction: prompt, status: 'queued', createdAt: now, updatedAt: now }
      state.runs.push(run)
      return { session: clone(session), task: clone(task), run: clone(run) }
    })
  }

  private async executeRun(runId: string, executor: RunAgentTaskInput['execute']): Promise<AgentToolResult> {
    const controller = new AbortController(); this.aborts.set(runId, controller)
    let binding: CoordinatorExecutionInput | undefined
    try {
      binding = this.mutate((state) => {
        const run = required(state.runs.find((item) => item.runId === runId), '找不到 subagent Run')
        if (run.status === 'cancelled') throw new Error(run.error ?? 'subagent Run 已取消')
        const session = required(state.sessions.find((item) => item.subagentId === run.subagentId), '找不到 subagent Session')
        const task = required(state.tasks.find((item) => item.taskId === run.taskId), '找不到 subagent Task')
        const now = Date.now(); run.status = 'running'; run.startedAt ??= now; run.updatedAt = now; session.status = 'busy'; session.currentRunId = run.runId; session.currentTaskId = task.taskId; session.lastUsedAt = now
        return { session: clone(session), task: clone(task), run: clone(run), feedback: state.feedback.filter((item) => item.taskId === task.taskId).map(clone), signal: controller.signal }
      })
      this.notify(binding.run.parentThreadId, binding.session, binding.task, binding.run)
      const execution = await executor(binding)
      const final = this.mutate((state) => this.finishRunInState(state, runId, execution))
      this.notify(final.run.parentThreadId, final.session, final.task, final.run)
      if (!final.run.report) throw new Error(final.run.error ?? 'Subagent Run 结束时没有提交 TaskReport')
      return { subagentId: final.run.subagentId, childThreadId: final.run.childThreadId, taskId: final.run.taskId, runId: final.run.runId, attempt: final.run.attempt, report: final.run.report }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const final = this.mutate((state) => this.finishRunInState(state, runId, { status: controller.signal.aborted ? 'cancelled' : 'errored', error: message }))
      this.notify(final.run.parentThreadId, final.session, final.task, final.run)
      throw error
    } finally { this.aborts.delete(runId) }
  }

  private finishRunInState(state: SubagentWorkStoreSnapshot, runId: string, execution: CoordinatorExecutionResult): { run: SubagentRun; task: SubagentTask; session: SubagentSession } {
    const run = required(state.runs.find((item) => item.runId === runId), '找不到 subagent Run')
    const task = required(state.tasks.find((item) => item.taskId === run.taskId), '找不到 subagent Task')
    const session = required(state.sessions.find((item) => item.subagentId === run.subagentId), '找不到 subagent Session')
    if (TERMINAL.has(run.status)) return { run: clone(run), task: clone(task), session: clone(session) }
    const completionSummary = execution.status === 'completed' ? execution.completionSummary?.trim() : undefined
    if (!run.report && completionSummary) run.report = normalizeReport({ status: 'submitted', summary: completionSummary })
    const now = Date.now(); const finalStatus = execution.status ?? (run.report ? 'completed' : 'errored')
    run.status = finalStatus; run.error = execution.error ?? (run.report ? undefined : 'Subagent Run 结束时没有提交 TaskReport'); run.endedAt = now; run.updatedAt = now
    task.status = 'awaiting_review'; task.updatedAt = now
    const priorReport = state.runs
      .filter((item) => item.taskId === task.taskId && item.runId !== run.runId && item.report)
      .sort((left, right) => right.attempt - left.attempt)[0]?.report
    task.stalled = Boolean(run.report && priorReport && reportFingerprint(run.report) === reportFingerprint(priorReport))
    session.status = 'idle'; session.currentRunId = undefined; session.currentTaskId = undefined; session.lastTaskSummary = task.objective; session.lastResultSummary = run.report?.summary ?? run.error
    return { run: clone(run), task: clone(task), session: clone(session) }
  }

  private mutate<T>(fn: (state: SubagentWorkStoreSnapshot) => T): T { const state = this.store.snapshot(); const result = fn(state); this.store.replace(state); return result }
  private async withPermit<T>(fn: () => Promise<T>): Promise<T> { await this.acquire(); try { return await fn() } finally { this.release() } }
  private async acquire(): Promise<void> { if (this.active < MAX_CONCURRENT_SUBAGENTS) { this.active += 1; return } await new Promise<void>((resolve) => this.waiters.push(resolve)); this.active += 1 }
  private release(): void { this.active -= 1; this.waiters.shift()?.() }
  private notify(parentThreadId: string, session?: SubagentSession, task?: SubagentTask, run?: SubagentRun): void { const event = { parentThreadId, ...(session ? { subagentId: session.subagentId } : {}), ...(task ? { taskId: task.taskId } : {}), ...(run ? { runId: run.runId } : {}), updatedAt: Date.now() }; for (const listener of this.listeners) listener(event) }
}

function normalizeReport(report: SubagentTaskReport): SubagentTaskReport { if (!report || !['submitted', 'failed', 'blocked'].includes(report.status) || !report.summary?.trim()) throw new Error('TaskReport 需要有效 status 和 summary'); return { ...report, summary: report.summary.trim() } }
function reportFingerprint(report: SubagentTaskReport): string {
  return JSON.stringify({
    status: report.status,
    summary: report.summary.trim(),
    artifacts: report.artifacts?.map((item) => item.path) ?? [],
    verification: report.verification?.map((item) => [item.command, item.result, item.passed]) ?? [],
  })
}
function toLink(run: SubagentRun): SubagentRunLink { return { parentThreadId: run.parentThreadId, parentRunId: run.parentRunId, parentToolUseId: run.parentToolUseId, subagentId: run.subagentId, childThreadId: run.childThreadId, taskId: run.taskId, runId: run.runId } }
function required<T>(value: T | undefined, message: string): T { if (!value) throw new Error(message); return value }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

let singleton: SubagentCoordinator | undefined
export function getSubagentCoordinator(): SubagentCoordinator { return singleton ??= new SubagentCoordinator() }
export function resetSubagentCoordinatorForTest(): void { singleton = undefined }
