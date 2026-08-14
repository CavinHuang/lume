import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { ToolDefinition, ToolExecutionMetadata, ToolResult } from '../types.js'
import { defineTool } from './types.js'

export type ProcessJobStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface ProcessJob {
  version?: 2
  id: string
  subject: string
  description?: string
  status: ProcessJobStatus
  threadId?: string
  runId?: string
  toolUseId?: string
  workerPid?: number
  processToken?: string
  workerIdentity?: string
  startedAt?: number
  updatedAt?: number
  heartbeatAt?: number
  output?: string
  outputFile?: string
  stdoutFile?: string
  stderrFile?: string
  resultFile?: string
  jobDir?: string
  taskType?: string
  metadata?: Record<string, unknown>
  notified?: boolean
  notificationDeliveredAt?: number
  continuationConsumedAt?: number
  stop?: () => void
}

export type CreateProcessJobInput = Omit<ProcessJob, 'id'> & { id?: string }

const jobs = new Map<string, ProcessJob>()
const terminalWaiters = new Map<string, Set<(job: ProcessJob | undefined) => void>>()
let counter = 0

export function createProcessJobRecord(input: CreateProcessJobInput): ProcessJob {
  const now = Date.now()
  const id = input.id ?? `task_${now}${++counter}`
  const job: ProcessJob = {
    version: 2,
    ...input,
    id,
    startedAt: input.startedAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
  jobs.set(job.id, job)
  persistProcessJob(job)
  return job
}

export function getProcessJob(id: string): ProcessJob | undefined {
  refreshProcessJob(id)
  return jobs.get(id)
}

export function removeProcessJob(id: string): void {
  notifyTerminalWaiters(id, undefined)
  jobs.delete(id)
}

export function discardProcessJob(id: string): void {
  const job = jobs.get(id)
  removeProcessJob(id)
  if (!job?.jobDir) return
  try {
    rmSync(job.jobDir, { recursive: true, force: true })
  } catch {
    // A worker may still be releasing a file handle; stale foreground records
    // are ignored by recovery once their state is terminal.
  }
}

export function updateProcessJob(id: string, patch: Partial<Omit<ProcessJob, 'id'>>): ProcessJob | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  Object.assign(job, patch, { updatedAt: Date.now() })
  persistProcessJob(job)
  if (job.status !== 'running') notifyTerminalWaiters(id, job)
  return job
}

export function markProcessJobNotified(id: string): boolean {
  const job = jobs.get(id)
  if (!job || job.notified || job.notificationDeliveredAt) return false
  job.notified = true
  job.notificationDeliveredAt = Date.now()
  job.updatedAt = Date.now()
  persistProcessJob(job)
  return true
}

export function markProcessJobContinuationConsumed(id: string): boolean {
  const job = getProcessJob(id)
  if (!job || job.continuationConsumedAt) return false
  job.continuationConsumedAt = Date.now()
  job.updatedAt = Date.now()
  persistProcessJob(job)
  return true
}

export function stopProcessJob(job: ProcessJob): void {
  if (job.stop) job.stop()
  else stopPersistedWorker(job)
}

export function loadProcessJobs(root: string): ProcessJob[] {
  const jobsRoot = resolve(root)
  if (!existsSync(jobsRoot)) return []
  const loaded: ProcessJob[] = []
  for (const entry of readdirSync(jobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const statePath = join(jobsRoot, entry.name, 'state.json')
    const parsed = readPersistedJob(statePath)
    if (!parsed) continue
    const current = jobs.get(parsed.id)
    if (!current || (parsed.updatedAt ?? 0) >= (current.updatedAt ?? 0)) {
      jobs.set(parsed.id, { ...current, ...parsed, stop: current?.stop })
    }
    const job = jobs.get(parsed.id)!
    loaded.push(job)
    if (job.status === 'running' && !isPersistedWorkerAlive(job)) {
      updateProcessJob(job.id, {
        status: 'interrupted',
        metadata: {
          ...job.metadata,
          execution: interruptedExecution(job),
        },
      })
    }
  }
  return loaded
}

export function processJobsRootForArtifacts(artifactsRoot?: string): string | undefined {
  return artifactsRoot ? join(resolve(artifactsRoot), 'process-jobs') : undefined
}

export function registerProcessStopHandler(id: string, handler: () => void): void {
  const job = jobs.get(id)
  if (job) job.stop = handler
}

export function unregisterProcessStopHandler(id: string): void {
  const job = jobs.get(id)
  if (job) delete job.stop
}

export function clearProcessJobs(): void {
  for (const id of terminalWaiters.keys()) notifyTerminalWaiters(id, undefined)
  jobs.clear()
  counter = 0
}

export function waitForProcessJobTerminal(
  id: string,
  timeoutMs = 45_000,
  abortSignal?: AbortSignal,
): Promise<ProcessJob | undefined> {
  const job = getProcessJob(id)
  if (!job || job.status !== 'running' || timeoutMs <= 0) return Promise.resolve(job)
  if (abortSignal?.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const waiters = terminalWaiters.get(id) ?? new Set()
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const finish = (next: ProcessJob | undefined, error?: Error) => {
      if (timer) clearTimeout(timer)
      if (poll) clearInterval(poll)
      abortSignal?.removeEventListener('abort', abort)
      waiters.delete(finish)
      if (waiters.size === 0) terminalWaiters.delete(id)
      if (error) reject(error)
      else resolve(next)
    }
    const abort = () => finish(getProcessJob(id), new Error('aborted'))
    waiters.add(finish)
    terminalWaiters.set(id, waiters)
    abortSignal?.addEventListener('abort', abort, { once: true })
    if (abortSignal?.aborted) {
      abort()
      return
    }
    poll = setInterval(() => {
      const next = getProcessJob(id)
      if (!next || next.status !== 'running') {
        finish(next)
      }
    }, 250)
    poll.unref?.()
    timer = setTimeout(() => {
      finish(getProcessJob(id))
    }, timeoutMs)
  })
}

function notifyTerminalWaiters(id: string, job: ProcessJob | undefined): void {
  const waiters = terminalWaiters.get(id)
  if (!waiters) return
  terminalWaiters.delete(id)
  for (const resolve of waiters) resolve(job)
}

export const ProcessStopTool: ToolDefinition = defineTool({
  name: 'ProcessStop',
  description: 'Stop an internal background process job.',
  inputSchema: {
    type: 'object',
    properties: { processId: { type: 'string' }, task_id: { type: 'string' }, reason: { type: 'string' } },
    required: [],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  validateInput(input) {
    if (!input?.processId && !input?.task_id) return 'processId or task_id is required.'
  },
  async call(input, context): Promise<ToolResult> {
    const id = input.processId ?? input.task_id
    hydrateContextProcessJobs(context.artifactsRoot)
    const job = getProcessJob(id)
    if (!job) return { type: 'tool_result', tool_use_id: '', content: `Process job not found: ${id}`, is_error: true }
    if (job.status !== 'running') {
      return { type: 'tool_result', tool_use_id: '', content: `Process job is already ${job.status}: ${job.id}`, _meta: { task: { id: job.id, status: job.status, kind: job.taskType || 'process' } } }
    }
    markProcessJobNotified(job.id)
    stopProcessJob(job)
    updateProcessJob(job.id, { status: 'stopped' })
    return { type: 'tool_result', tool_use_id: '', content: `Process job stopped: ${job.id}`, _meta: { task: { id: job.id, status: 'stopped', kind: job.taskType || 'process' } } }
  },
})

export const ProcessOutputTool: ToolDefinition = defineTool({
  name: 'ProcessOutput',
  description: 'Manually inspect an internal background process when the user explicitly asks. Background commands emit a terminal notification and expose an output file, so do not poll this tool while waiting.',
  inputSchema: {
    type: 'object',
    properties: {
      processId: { type: 'string' }, task_id: { type: 'string' }, block: { type: 'boolean' }, timeout: { type: 'number' },
      offset: { type: 'number', description: 'Byte offset for incremental output reads.' },
      limit: { type: 'number', description: 'Maximum output bytes to return (default 65536).' },
    },
    required: [],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  validateInput(input) {
    if (!input?.processId && !input?.task_id) return 'processId or task_id is required.'
    if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout < 0)) return 'timeout must be non-negative.'
    if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) return 'offset must be a non-negative integer.'
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) return 'limit must be a positive integer.'
  },
  async call(input, context) {
    const id = input.processId ?? input.task_id
    hydrateContextProcessJobs(context.artifactsRoot)
    let job = getProcessJob(id)
    if (!job) return { data: `Process job not found: ${id}`, is_error: true }
    const block = input.block !== false
    const timeout = Math.min(Math.max(Number(input.timeout ?? 30_000), 0), 600_000)
    if (block && job.status === 'running') {
      job = await waitForProcessJobTerminal(id, timeout)
      if (!job) return { data: `Process job not found: ${id}`, is_error: true }
    }
    const offset = Number(input.offset ?? 0)
    const limit = Math.min(Number(input.limit ?? 65_536), 1_048_576)
    const output = await readJobOutput(job, offset, limit)
    if (job.status !== 'running' && markProcessJobNotified(job.id)) {
      const execution = job.metadata?.execution as ToolExecutionMetadata | undefined
      context.emitEvent?.({
        type: 'system',
        subtype: 'task_notification',
        task_id: job.id,
        ...(job.toolUseId ? { tool_use_id: job.toolUseId } : {}),
        status: job.status,
        output_file: job.outputFile,
        summary: `Background process ${job.status}. Full output: ${job.outputFile ?? '(unavailable)'}`,
        message: output.text || job.output || '(no output)',
        ...(execution && typeof execution === 'object' ? { execution } : {}),
        session_id: job.threadId ?? context.sessionId ?? '',
      })
      context.onBackgroundTaskCompleted?.()
    }
    return {
      data: {
        retrieval_status: job.status === 'running' ? (block ? 'timeout' : 'not_ready') : 'success',
        process: { process_id: job.id, task_id: job.id, status: job.status, kind: job.taskType || 'process', output: output.text || '(no output yet)' },
      },
      ...(job.metadata?.execution && typeof job.metadata.execution === 'object'
        ? { _meta: { execution: job.metadata.execution, task: { id: job.id, status: job.status, kind: job.taskType || 'process', outputOffset: offset, nextOffset: output.nextOffset, outputSize: output.size, truncated: output.truncated } } }
        : { _meta: { task: { id: job.id, status: job.status, kind: job.taskType || 'process', outputOffset: offset, nextOffset: output.nextOffset, outputSize: output.size, truncated: output.truncated } } }),
    }
  },
})

/** Compatibility aliases for SDK callers that used the pre-redesign helpers. */
export const TaskOutputTool = ProcessOutputTool

async function readJobOutput(job: ProcessJob, offset: number, limit: number): Promise<{ text: string; size: number; nextOffset: number; truncated: boolean }> {
  if (!job.outputFile) {
    const text = job.output ?? ''
    const bytes = Buffer.from(text)
    return decodeUtf8Window(bytes, bytes.length, offset, limit, 0)
  }
  try {
    const info = await stat(job.outputFile)
    const readStart = Math.max(0, Math.min(offset, info.size) - 3)
    const bytes = Buffer.alloc(Math.min(limit + 6, info.size - readStart))
    const file = await open(job.outputFile, 'r')
    try {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, readStart)
      return decodeUtf8Window(bytes.subarray(0, bytesRead), info.size, offset, limit, readStart)
    } finally {
      await file.close()
    }
  } catch (error) {
    const fallback = job.output ?? ''
    const reason = error instanceof Error ? error.message : String(error)
    const diagnostic = `Unable to read background output file ${job.outputFile}: ${reason}`
    const text = fallback ? `${diagnostic}\n${fallback}` : diagnostic
    return { text, size: Buffer.byteLength(text), nextOffset: offset, truncated: false }
  }
}

function hydrateContextProcessJobs(artifactsRoot?: string): void {
  const root = processJobsRootForArtifacts(artifactsRoot)
  if (root) loadProcessJobs(root)
}

function persistProcessJob(job: ProcessJob): void {
  if (!job.jobDir) return
  try {
    mkdirSync(job.jobDir, { recursive: true })
    const statePath = join(job.jobDir, 'state.json')
    const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`
    const persisted = readPersistedJob(statePath)
    const persistedWorkerIdentity = persisted && persisted.processToken === job.processToken
      ? persisted.workerIdentity
      : undefined
    const serializable = {
      ...job,
      ...(!job.workerIdentity && persistedWorkerIdentity
        ? { workerIdentity: persistedWorkerIdentity }
        : {}),
      stop: undefined,
    }
    writeFileSync(temporary, JSON.stringify(serializable, null, 2), 'utf8')
    renameSync(temporary, statePath)
  } catch {
    // Persistence is best-effort for standalone SDK callers. Lume supplies a
    // writable artifacts root and verifies this path in integration tests.
  }
}

function refreshProcessJob(id: string): void {
  const current = jobs.get(id)
  if (!current?.jobDir) return
  const persisted = readPersistedJob(join(current.jobDir, 'state.json'))
  if (!persisted || (persisted.updatedAt ?? 0) < (current.updatedAt ?? 0)) return
  jobs.set(id, { ...current, ...persisted, stop: current.stop })
}

function readPersistedJob(statePath: string): ProcessJob | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as ProcessJob
    if (parsed.version !== 2 || typeof parsed.id !== 'string' || typeof parsed.status !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function isPersistedWorkerAlive(job: ProcessJob): boolean {
  if (!job.workerPid || job.workerPid <= 0) return false
  if (job.heartbeatAt && Date.now() - job.heartbeatAt > 15_000) return false
  try {
    process.kill(job.workerPid, 0)
  } catch {
    return false
  }
  if (!job.workerIdentity) return true
  if (!job.processToken) return false
  const processIdentity = readProcessIdentity(job.workerPid)
  return processIdentity !== undefined
    && job.workerIdentity === `${job.processToken}:${processIdentity}`
}

function stopPersistedWorker(job: ProcessJob): void {
  if (!job.workerPid || job.workerPid <= 0) return
  if (job.workerIdentity && !isPersistedWorkerAlive(job)) return
  if (process.platform === 'win32') {
    const child = spawn('taskkill', ['/PID', String(job.workerPid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return
  }
  try {
    process.kill(-job.workerPid, 'SIGTERM')
  } catch {
    try {
      process.kill(job.workerPid, 'SIGTERM')
    } catch {
      // Process already exited.
    }
  }
}

function readProcessIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform === 'linux') {
    try {
      const statLine = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const processNameEnd = statLine.lastIndexOf(')')
      const fieldsAfterName = statLine.slice(processNameEnd + 2).trim().split(/\s+/)
      const startTimeTicks = fieldsAfterName[19]
      return startTimeTicks ? `linux:${startTimeTicks}` : undefined
    } catch {
      return undefined
    }
  }
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `([DateTimeOffset]((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime())).ToUnixTimeSeconds()`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
    const ticks = result.status === 0 ? result.stdout.trim() : ''
    return ticks ? `win32:${ticks}` : undefined
  }
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : ''
  return startedAt ? `${process.platform}:${startedAt}` : undefined
}

function interruptedExecution(job: ProcessJob): Record<string, unknown> {
  const execution = job.metadata?.execution
  const source = execution && typeof execution === 'object' ? execution as Record<string, unknown> : {}
  return {
    ...source,
    version: 2,
    outcome: 'interrupted',
    terminationReason: 'interrupted',
    durationMs: Math.max(0, Date.now() - (job.startedAt ?? Date.now())),
  }
}

function decodeUtf8Window(bytes: Buffer, size: number, requestedOffset: number, limit: number, baseOffset: number): { text: string; size: number; nextOffset: number; truncated: boolean } {
  let start = Math.max(0, requestedOffset - baseOffset)
  while (start < bytes.length && isUtf8Continuation(bytes[start]!)) start += 1
  let end = Math.min(bytes.length, start + limit)
  while (end < bytes.length && isUtf8Continuation(bytes[end]!)) end += 1
  const nextOffset = Math.min(size, baseOffset + end)
  return {
    text: bytes.subarray(start, end).toString('utf8'),
    size,
    nextOffset,
    truncated: nextOffset < size,
  }
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}
