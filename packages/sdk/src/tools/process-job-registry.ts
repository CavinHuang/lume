import { open, stat } from 'node:fs/promises'
import type { ToolDefinition, ToolResult } from '../types.js'
import { defineTool } from './types.js'

export type ProcessJobStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface ProcessJob {
  id: string
  subject: string
  description?: string
  status: ProcessJobStatus
  output?: string
  outputFile?: string
  taskType?: string
  metadata?: Record<string, unknown>
  stop?: () => void
}

// This registry is intentionally limited to ephemeral Bash process handles.
// It is not a source of Task state and is never exposed to the model as a list.
const jobs = new Map<string, ProcessJob>()
let counter = 0

export function createProcessJobRecord(input: Omit<ProcessJob, 'id'>): ProcessJob {
  // Keep the historical opaque handle shape for callers that persisted Bash
  // job references; this is not a Task id and never enters the Task store.
  const job: ProcessJob = { ...input, id: `task_${++counter}` }
  jobs.set(job.id, job)
  return job
}

export function getProcessJob(id: string): ProcessJob | undefined {
  return jobs.get(id)
}

export function updateProcessJob(id: string, patch: Partial<Omit<ProcessJob, 'id'>>): ProcessJob | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  Object.assign(job, patch)
  return job
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
  jobs.clear()
  counter = 0
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
  async call(input): Promise<ToolResult> {
    const id = input.processId ?? input.task_id
    const job = getProcessJob(id)
    if (!job) return { type: 'tool_result', tool_use_id: '', content: `Process job not found: ${id}`, is_error: true }
    if (job.status !== 'running') {
      return { type: 'tool_result', tool_use_id: '', content: `Process job is already ${job.status}: ${job.id}`, _meta: { task: { id: job.id, status: job.status, kind: job.taskType || 'process' } } }
    }
    job.stop?.()
    updateProcessJob(job.id, { status: 'stopped' })
    return { type: 'tool_result', tool_use_id: '', content: `Process job stopped: ${job.id}`, _meta: { task: { id: job.id, status: 'stopped', kind: job.taskType || 'process' } } }
  },
})

export const ProcessOutputTool: ToolDefinition = defineTool({
  name: 'ProcessOutput',
  description: 'Read output from an internal background process job.',
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
  async call(input) {
    const id = input.processId ?? input.task_id
    let job = getProcessJob(id)
    if (!job) return { data: `Process job not found: ${id}`, is_error: true }
    const block = input.block !== false
    const timeout = Math.min(Math.max(Number(input.timeout ?? 30_000), 0), 600_000)
    const started = Date.now()
    while (block && job.status === 'running' && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      job = getProcessJob(id)
      if (!job) return { data: `Process job not found: ${id}`, is_error: true }
    }
    const offset = Number(input.offset ?? 0)
    const limit = Math.min(Number(input.limit ?? 65_536), 1_048_576)
    const output = await readJobOutput(job, offset, limit)
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
  } catch {
    return { text: job.output ?? '', size: Buffer.byteLength(job.output ?? ''), nextOffset: offset, truncated: false }
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
