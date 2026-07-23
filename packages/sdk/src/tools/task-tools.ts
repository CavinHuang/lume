/**
 * Task Management Tools
 *
 * TaskCreate, TaskList, TaskUpdate, TaskGet, TaskStop, TaskOutput
 *
 * Provides in-memory task tracking for agent coordination.
 * Tasks persist across turns within a session.
 */

import type { ToolDefinition, ToolResult } from '../types.js'

/**
 * Task status.
 */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stopped'

/**
 * Task entry.
 */
export interface Task {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  owner?: string
  createdAt: string
  updatedAt: string
  output?: string
  outputFile?: string
  taskType?: string
  blockedBy?: string[]
  blocks?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Global task store (shared across tools in a session).
 */
const taskStore = new Map<string, Task>()
const taskStopHandlers = new Map<string, () => void>()

let taskCounter = 0

/**
 * Get all tasks.
 */
export function getAllTasks(): Task[] {
  return Array.from(taskStore.values())
}

/**
 * Get a task by ID.
 */
export function getTask(id: string): Task | undefined {
  return taskStore.get(id)
}

/**
 * Clear all tasks (for session reset).
 */
export function clearTasks(): void {
  taskStore.clear()
  taskStopHandlers.clear()
  taskCounter = 0
}

export function registerTaskStopHandler(id: string, handler: () => void): void {
  taskStopHandlers.set(id, handler)
}

export function unregisterTaskStopHandler(id: string): void {
  taskStopHandlers.delete(id)
}

export function createTaskRecord(input: {
  subject: string
  description?: string
  activeForm?: string
  owner?: string
  status?: TaskStatus
  outputFile?: string
  taskType?: string
  metadata?: Record<string, unknown>
}): Task {
  const id = `task_${++taskCounter}`
  const task: Task = {
    id,
    subject: input.subject,
    description: input.description,
    activeForm: input.activeForm,
    status: input.status || 'pending',
    owner: input.owner,
    outputFile: input.outputFile,
    taskType: input.taskType,
    metadata: input.metadata,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  taskStore.set(id, task)
  return task
}

export function updateTaskRecord(
  id: string,
  patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
): Task | undefined {
  const task = taskStore.get(id)
  if (!task) return undefined
  Object.assign(task, patch)
  task.updatedAt = new Date().toISOString()
  return task
}

// ============================================================================
// TaskCreateTool
// ============================================================================

export const TaskCreateTool: ToolDefinition = {
  name: 'TaskCreate',
  description: 'Create a new task for tracking work progress. Tasks help organize multi-step operations.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Short task title' },
      description: { type: 'string', description: 'Detailed task description' },
      activeForm: { type: 'string', description: 'Present-continuous label while the task is running' },
      owner: { type: 'string', description: 'Task owner/assignee' },
      status: { type: 'string', enum: ['pending', 'in_progress'], description: 'Initial status' },
    },
    required: ['subject'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Create a task for tracking progress.' },
  async call(input: any): Promise<ToolResult> {
    const task = createTaskRecord({
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: input.status || 'pending',
      owner: input.owner,
    })

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Task created: ${task.id} - "${task.subject}" (${task.status})`,
    }
  },
}

// ============================================================================
// TaskListTool
// ============================================================================

export const TaskListTool: ToolDefinition = {
  name: 'TaskList',
  description: 'List all tasks with their status, ownership, and dependencies.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter by status' },
      owner: { type: 'string', description: 'Filter by owner' },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'List tasks.' },
  async call(input: any): Promise<ToolResult> {
    let tasks = getAllTasks()

    if (input.status) {
      tasks = tasks.filter(t => t.status === input.status)
    }
    if (input.owner) {
      tasks = tasks.filter(t => t.owner === input.owner)
    }

    if (tasks.length === 0) {
      return { type: 'tool_result', tool_use_id: '', content: 'No tasks found.' }
    }

    const lines = tasks.map(t =>
      `[${t.id}] ${t.status.toUpperCase()} - ${t.subject}${t.owner ? ` (owner: ${t.owner})` : ''}`
    )

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: lines.join('\n'),
    }
  },
}

// ============================================================================
// TaskUpdateTool
// ============================================================================

export const TaskUpdateTool: ToolDefinition = {
  name: 'TaskUpdate',
  description: 'Update a task\'s status, description, or other properties.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'running', 'completed', 'failed', 'cancelled', 'stopped'] },
      description: { type: 'string', description: 'Updated description' },
      activeForm: { type: 'string', description: 'Present-continuous status label shown while in progress' },
      owner: { type: 'string', description: 'New owner' },
      output: { type: 'string', description: 'Task output/result' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Update a task.' },
  async call(input: any): Promise<ToolResult> {
    const task = taskStore.get(input.id)
    if (!task) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }

    if (input.status) task.status = input.status
    if (input.description) task.description = input.description
    if (input.activeForm) task.activeForm = input.activeForm
    if (input.owner) task.owner = input.owner
    if (input.output) task.output = input.output
    task.updatedAt = new Date().toISOString()

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Task updated: ${task.id} - ${task.status} - "${task.subject}"`,
    }
  },
}

// ============================================================================
// TaskGetTool
// ============================================================================

export const TaskGetTool: ToolDefinition = {
  name: 'TaskGet',
  description: 'Get full details of a specific task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
    },
    required: ['id'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Get task details.' },
  async call(input: any): Promise<ToolResult> {
    const task = taskStore.get(input.id)
    if (!task) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify(task, null, 2),
    }
  },
}

// ============================================================================
// TaskStopTool
// ============================================================================

export const TaskStopTool: ToolDefinition = {
  name: 'TaskStop',
  description: 'Stop a running background task by task ID.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID to stop' },
      shell_id: { type: 'string', description: 'Deprecated alias for task_id' },
      reason: { type: 'string', description: 'Reason for stopping' },
    },
    required: ['task_id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Stop a task.' },
  async call(input: any): Promise<ToolResult> {
    const taskId = input.task_id ?? input.shell_id ?? input.id
    const task = taskStore.get(taskId)
    if (!task) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${taskId}`, is_error: true }
    }

    task.status = 'stopped'
    task.updatedAt = new Date().toISOString()
    taskStopHandlers.get(task.id)?.()
    taskStopHandlers.delete(task.id)
    if (input.reason) task.output = `Stopped: ${input.reason}`

    const execution = task.metadata?.execution
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify({
        message: `Successfully stopped task: ${task.id}${task.description ? ` (${task.description})` : ''}`,
        task_id: task.id,
        task_type: task.taskType || 'unknown',
        command: task.description || task.subject,
      }),
      ...(execution && typeof execution === 'object' ? { _meta: { execution } } : {}),
    }
  },
}

// ============================================================================
// TaskOutputTool
// ============================================================================

export const TaskOutputTool: ToolDefinition = {
  name: 'TaskOutput',
  description: 'Get output from a running or completed background task.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID' },
      block: { type: 'boolean', description: 'Whether to wait for completion (default: true)' },
      timeout: { type: 'number', description: 'Maximum wait time in milliseconds (default: 30000)' },
    },
    required: ['task_id'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Get task output.' },
  async call(input: any): Promise<ToolResult> {
    const taskId = input.task_id ?? input.id
    let task = taskStore.get(taskId)
    if (!task) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${taskId}`, is_error: true }
    }

    const block = input.block !== false
    const timeout = Math.max(0, Math.min(Number(input.timeout ?? 30000), 600000))
    if (block && (task.status === 'running' || task.status === 'in_progress' || task.status === 'pending')) {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const current = taskStore.get(taskId)
        if (!current) break
        if (current.status !== 'running' && current.status !== 'in_progress' && current.status !== 'pending') {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      task = taskStore.get(taskId)
      if (!task) {
        return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${taskId}`, is_error: true }
      }
    }

    if (!task.output && task.outputFile) {
      try {
        const { readFile } = await import('fs/promises')
        task.output = await readFile(task.outputFile, 'utf-8')
      } catch {
        // Ignore unreadable task output files and fall back to in-memory output.
      }
    }

    const execution = task.metadata?.execution
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify({
        retrieval_status:
          task.status === 'running' || task.status === 'in_progress' || task.status === 'pending'
            ? block
              ? 'timeout'
              : 'not_ready'
            : 'success',
        task: {
          task_id: task.id,
          task_type: task.taskType || 'unknown',
          status: task.status,
          description: task.subject,
          activeForm: task.activeForm,
          output: task.output || '(no output yet)',
          error: task.status === 'failed' ? task.output || 'Task failed' : undefined,
        },
      }),
      ...(execution && typeof execution === 'object' ? { _meta: { execution } } : {}),
    }
  },
}
