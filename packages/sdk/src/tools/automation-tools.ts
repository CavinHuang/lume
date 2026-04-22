import type { ToolDefinition, ToolResult } from '../types.js'

const PRESET_CRON_MAP: Record<string, string> = {
  hourly: '0 * * * *',
  daily: '0 9 * * *',
  weekly: '0 9 * * 1',
  monthly: '0 9 1 * *',
}

export interface AutomationJob {
  id: string
  name: string
  prompt: string
  schedule: { type: string; cronExpr?: string; runAt?: number; intervalMs?: number }
  enabled: boolean
  workspaceId?: string
  createdAt: string
}

const jobStore = new Map<string, AutomationJob>()
let jobCounter = 0

export const AutomationCreateTool: ToolDefinition = {
  name: 'automation_create',
  description: 'Create an automation task. Supports cron expressions and preset frequencies (hourly/daily/weekly/monthly).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Task name' },
      prompt: { type: 'string', description: 'Prompt to execute' },
      schedule: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['cron', 'preset', 'once'] },
          expression: { type: 'string', description: 'Cron expression (type=cron)' },
          preset: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'], description: 'Preset frequency (type=preset)' },
          runAt: { type: 'number', description: 'Timestamp for one-time execution (type=once)' },
        },
      },
    },
    required: ['name', 'prompt', 'schedule'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Create an automation task.' },
  async call(input: any): Promise<ToolResult> {
    const id = `auto_${++jobCounter}`
    let cronExpr = input.schedule?.expression
    if (input.schedule?.type === 'preset' && input.schedule.preset) {
      cronExpr = PRESET_CRON_MAP[input.schedule.preset]
    }
    const job: AutomationJob = {
      id,
      name: input.name,
      prompt: input.prompt,
      schedule: { type: input.schedule?.type === 'once' ? 'once' : 'cron', cronExpr, runAt: input.schedule?.runAt },
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    jobStore.set(id, job)
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Automation task created: ${id} "${job.name}"`,
    }
  },
}

export const AutomationListTool: ToolDefinition = {
  name: 'automation_list',
  description: 'List all automation tasks.',
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'List automation tasks.' },
  async call(): Promise<ToolResult> {
    const jobs = Array.from(jobStore.values())
    if (jobs.length === 0) {
      return { type: 'tool_result', tool_use_id: '', content: 'No automation tasks.' }
    }
    const lines = jobs.map(j =>
      `[${j.id}] ${j.enabled ? '✓' : '✗'} "${j.name}" schedule="${j.schedule.cronExpr ?? 'once'}" prompt="${j.prompt.slice(0, 50)}"`
    )
    return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
  },
}

export const AutomationDeleteTool: ToolDefinition = {
  name: 'automation_delete',
  description: 'Delete an automation task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID to delete' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Delete an automation task.' },
  async call(input: any): Promise<ToolResult> {
    if (!jobStore.has(input.id)) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }
    jobStore.delete(input.id)
    return { type: 'tool_result', tool_use_id: '', content: `Task deleted: ${input.id}` }
  },
}

export const AutomationUpdateTool: ToolDefinition = {
  name: 'automation_update',
  description: 'Update an automation task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
      name: { type: 'string', description: 'New name' },
      prompt: { type: 'string', description: 'New prompt' },
      enabled: { type: 'boolean', description: 'Enable/disable' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Update an automation task.' },
  async call(input: any): Promise<ToolResult> {
    const job = jobStore.get(input.id)
    if (!job) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }
    if (input.name !== undefined) job.name = input.name
    if (input.prompt !== undefined) job.prompt = input.prompt
    if (input.enabled !== undefined) job.enabled = input.enabled
    return { type: 'tool_result', tool_use_id: '', content: `Task updated: ${input.id} "${job.name}"` }
  },
}

export const AutomationRunNowTool: ToolDefinition = {
  name: 'automation_run_now',
  description: 'Immediately execute an automation task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID to execute' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Execute an automation task now.' },
  async call(input: any): Promise<ToolResult> {
    const job = jobStore.get(input.id)
    if (!job) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }
    return { type: 'tool_result', tool_use_id: '', content: `Task triggered: ${input.id} "${job.name}" (async execution)` }
  },
}
