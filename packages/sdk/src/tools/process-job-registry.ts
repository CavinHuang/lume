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
    properties: { processId: { type: 'string' }, reason: { type: 'string' } },
    required: ['processId'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input): Promise<ToolResult> {
    const job = getProcessJob(input.processId)
    if (!job) return { type: 'tool_result', tool_use_id: '', content: `Process job not found: ${input.processId}`, is_error: true }
    job.stop?.()
    return { type: 'tool_result', tool_use_id: '', content: `Process job stopped: ${job.id}` }
  },
})

export const ProcessOutputTool: ToolDefinition = defineTool({
  name: 'ProcessOutput',
  description: 'Read output from an internal background process job.',
  inputSchema: {
    type: 'object',
    properties: { processId: { type: 'string' }, block: { type: 'boolean' }, timeout: { type: 'number' } },
    required: ['processId'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
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
    if (!job.output && job.outputFile) {
      try {
        const { readFile } = await import('node:fs/promises')
        job.output = await readFile(job.outputFile, 'utf8')
      } catch {
        // The process result remains available through its in-memory summary.
      }
    }
    return {
      data: {
        retrieval_status: job.status === 'running' ? (block ? 'timeout' : 'not_ready') : 'success',
        process: { process_id: job.id, status: job.status, output: job.output ?? '(no output yet)' },
      },
      ...(job.metadata?.execution && typeof job.metadata.execution === 'object'
        ? { _meta: { execution: job.metadata.execution } }
        : {}),
    }
  },
})

/** Compatibility aliases for SDK callers that used the pre-redesign helpers. */
export const TaskOutputTool = ProcessOutputTool
