/**
 * Claude Code-style persistent Task tools.
 *
 * The SDK only owns the tool contract. State is supplied by the host through
 * TaskStoreAdapter so a Task list can be scoped to a thread and persisted by
 * the sidecar. In particular, this module deliberately has no module-level
 * Task state.
 */

import type { ToolDefinition, ToolResult } from '../types.js'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskMetadata {
  [key: string]: unknown
}

export interface Task {
  id: string
  subject: string
  description?: string
  activeForm?: string
  owner?: string
  status: TaskStatus
  blocks: string[]
  blockedBy: string[]
  metadata?: TaskMetadata
}

export interface TaskRef {
  taskListId: string
  taskId: string
  claimToken: string
}

export interface TaskStoreContext {
  threadId: string
  threadType: 'main' | 'subagent' | 'group' | 'channel' | 'system' | 'recovery'
  actorId: string
  runId?: string
  trusted?: boolean
}

export interface TaskMutationResult {
  task: Task
  revision: number
  claimToken?: string
}

export interface TaskStoreAdapter {
  create(input: {
    subject: string
    description?: string
    activeForm?: string
  }, context: TaskStoreContext): Promise<TaskMutationResult>
  update(input: Record<string, unknown>, context: TaskStoreContext): Promise<TaskMutationResult>
  list(input: { status?: TaskStatus; owner?: string }, context: TaskStoreContext): Promise<Task[]>
  get(taskId: string, context: TaskStoreContext): Promise<TaskMutationResult | null>
  delete(taskId: string, context: TaskStoreContext): Promise<void>
  stop(input: { taskId: string; expectedRevision?: number; claimToken?: string; reason?: string }, context: TaskStoreContext): Promise<TaskMutationResult>
}

function result(content: unknown, isError = false): ToolResult {
  return {
    type: 'tool_result',
    tool_use_id: '',
    content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    ...(isError ? { is_error: true } : {}),
  }
}

function contextFrom(input: {
  threadId: string
  threadType: TaskStoreContext['threadType']
  actorId: string
  runId?: string
}): TaskStoreContext {
  return input
}

export function createTaskTools(input: {
  store: TaskStoreAdapter
  context: Omit<TaskStoreContext, 'runId'>
  getRunId?: () => string | undefined
}): ToolDefinition[] {
  const context = (): TaskStoreContext => contextFrom({
    ...input.context,
    ...(input.getRunId?.() ? { runId: input.getRunId?.() } : {}),
  })

  const taskCreate: ToolDefinition = {
    name: 'TaskCreate',
    description: 'Create a persistent task item that survives across turns. Use TaskUpdate to add dependencies or claim it; set activeForm to a present-progressive label shown to the user while the task executes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['subject'],
      properties: {
        subject: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        activeForm: { type: 'string', description: 'Present-progressive label shown to the user while this task is executing (e.g. "Verifying dependencies")' },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() { return 'Create a persistent cross-turn task item.' },
    async call(raw): Promise<ToolResult> {
      try {
        const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        const subject = typeof value.subject === 'string' ? value.subject.trim() : ''
        if (!subject) return result('TaskCreate requires a non-empty subject.', true)
        const created = await input.store.create({
          subject,
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
          ...(typeof value.activeForm === 'string' ? { activeForm: value.activeForm } : {}),
        }, context())
        return result(created)
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true)
      }
    },
  }

  const taskList: ToolDefinition = {
    name: 'TaskList',
    description: 'List persistent tasks and their dependency/ownership summary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        owner: { type: 'string' },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    async prompt() { return 'List persistent tasks.' },
    async call(raw): Promise<ToolResult> {
      try {
        const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        const status = value.status === 'pending' || value.status === 'in_progress' || value.status === 'completed'
          ? value.status
          : undefined
        const tasks = await input.store.list({
          ...(status ? { status } : {}),
          ...(typeof value.owner === 'string' ? { owner: value.owner } : {}),
        }, context())
        return result(tasks)
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true)
      }
    },
  }

  const taskUpdate: ToolDefinition = {
    name: 'TaskUpdate',
    description: 'Update a persistent task, claim it, complete it, reopen it to pending, or add/remove dependencies. Workflow: claim a task with status "in_progress" immediately before you start working on it, mark it "completed" as soon as the work is done, and keep at most one task "in_progress" at a time. Status changes are fenced: pass expectedRevision from your last read (omitting it commits against the current revision), plus claimToken while the task is in_progress (omitting it reuses your own active claim). A blocked task cannot be claimed or completed until its blockers complete. A completed task can only transition back to pending (reopen).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        owner: { type: ['string', 'null'] },
        metadata: { type: ['object', 'null'] },
        delete: { type: 'boolean', description: 'Delete this task when it is pending.' },
        addBlocks: { type: 'array', items: { type: 'string' } },
        addBlockedBy: { type: 'array', items: { type: 'string' } },
        removeBlocks: { type: 'array', items: { type: 'string' } },
        removeBlockedBy: { type: 'array', items: { type: 'string' } },
        expectedRevision: { type: 'number' },
        claimToken: { type: 'string' },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() { return 'Claim, complete, or update a persistent task. Claim a task as in_progress right before working on it; mark completed immediately when done.' },
    async call(raw): Promise<ToolResult> {
      try {
        const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        if (typeof value.taskId !== 'string' || !value.taskId.trim()) return result('TaskUpdate requires taskId.', true)
        if (value.delete === true) {
          await input.store.delete(value.taskId, context())
          return result({ deleted: value.taskId })
        }
        const updated = await input.store.update(value, context())
        return result(updated)
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true)
      }
    },
  }

  const taskGet: ToolDefinition = {
    name: 'TaskGet',
    description: 'Get one persistent task with its revision and claim details.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: { taskId: { type: 'string' } },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    async prompt() { return 'Get persistent task details.' },
    async call(raw): Promise<ToolResult> {
      try {
        const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        if (typeof value.taskId !== 'string' || !value.taskId.trim()) return result('TaskGet requires taskId.', true)
        const task = await input.store.get(value.taskId, context())
        return task ? result(task) : result(`Task not found: ${value.taskId}`, true)
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true)
      }
    },
  }

  const taskStop: ToolDefinition = {
    name: 'TaskStop',
    description: 'Cancel the current claim and return an in-progress task to pending.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        expectedRevision: { type: 'number' },
        claimToken: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() { return 'Stop the active claim for a persistent task.' },
    async call(raw): Promise<ToolResult> {
      try {
        const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        if (typeof value.taskId !== 'string' || !value.taskId.trim()) return result('TaskStop requires taskId.', true)
        const stopped = await input.store.stop({
          taskId: value.taskId,
          ...(typeof value.expectedRevision === 'number' ? { expectedRevision: value.expectedRevision } : {}),
          ...(typeof value.claimToken === 'string' ? { claimToken: value.claimToken } : {}),
          ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
        }, context())
        return result(stopped)
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true)
      }
    },
  }

  return [taskCreate, taskUpdate, taskList, taskGet, taskStop]
}

export type TaskToolName = 'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'TaskGet' | 'TaskStop'

