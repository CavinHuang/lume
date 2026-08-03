/**
 * TodoWriteTool — per-session todo/checklist management.
 *
 * Factory-based: each session builds its own tool instance via
 * createTodoTool({ threadId }). State lives in a per-instance store,
 * so sessions/threads/subagents never share todo state.
 */

import { defineTool } from './types.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** Imperative form, e.g. "Run tests" */
  content: string
  /** Present-continuous form shown during execution, e.g. "Running tests" */
  activeForm: string
  status: TodoStatus
}

/** Snapshot pushed to the UI via onTodoUpdated. */
export interface TodoState {
  todos: TodoItem[]
  /** activeForm of the single in_progress task, or null if none. */
  currentActiveForm: string | null
}

const PROMPT = `Use this tool to manage a structured task list for the current session. It tracks progress on multi-step work and shows the user what is being done.

## When to use
- Complex tasks with 3+ distinct steps
- The user provides multiple tasks (numbered or comma-separated)
- After receiving new instructions — capture them as todos immediately
- Before starting a task — mark it in_progress

## When NOT to use
- A single trivial task
- Purely informational or conversational requests
- Fewer than 3 trivial steps

## Rules
- States: pending | in_progress | completed
- Keep EXACTLY ONE task in_progress at a time
- Mark a task completed the moment it is done — do not batch
- Before any final answer, reconcile the list with actual work and call TodoWrite again; no task may remain pending or in_progress
- Do not mark work completed unless it was actually performed and, when applicable, verified
- Each item needs BOTH forms:
  - content: imperative ("Run tests")
  - activeForm: present continuous ("Running tests")
`

function statusMarker(status: TodoStatus): string {
  if (status === 'completed') return '[x]'
  if (status === 'in_progress') return '[~]'
  return '[ ]'
}

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'No active todos.'
  return todos.map((t) => `${statusMarker(t.status)} ${t.content}`).join('\n')
}

const VERIFICATION_NUDGE =
  '\n\n[verification needed] 多个任务被一次性标记为完成。请回到当前 Run 执行相关验证并检查最终 Diff，再结束本轮。'

function countNewlyCompleted(prev: TodoItem[], next: TodoItem[]): number {
  const prevCompleted = new Set(prev.filter((t) => t.status === 'completed').map((t) => t.content))
  return next.filter((t) => t.status === 'completed' && !prevCompleted.has(t.content)).length
}

function coerceStatus(value: unknown): TodoStatus {
  if (value === 'in_progress') return 'in_progress'
  if (value === 'completed') return 'completed'
  return 'pending'
}

/** Narrow an arbitrary value to a string-keyed record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Isolated state container for one session's todos. Each createTodoTool
 * instance owns its own store, so state never leaks across sessions.
 */
export function createTodoStore() {
  const items: TodoItem[] = []
  return {
    set(next: TodoItem[]): void {
      items.length = 0
      for (const t of next) items.push(t)
    },
    getAll(): TodoItem[] {
      // Per-element copy: callers may mutate the returned objects
      // without corrupting the store's internal state.
      return items.map((t) => ({ ...t }))
    },
  }
}

/**
 * Build a per-session TodoWrite tool. State is scoped to this instance
 * via an internal store; the module no longer holds any global state.
 */
export function createTodoTool(opts: {
  threadId: string
  initialTodos?: TodoItem[]
  onTodoUpdated?: (state: TodoState) => void | Promise<void>
}) {
  if (!opts?.threadId) {
    throw new Error('createTodoTool requires a threadId')
  }
  const store = createTodoStore()
  store.set(opts.initialTodos ?? [])

  return defineTool({
    name: 'TodoWrite',
    description:
      'Update the complete session todo list. Keep exactly one task in_progress, mark each completed immediately after actual completion, and call TodoWrite again before the final answer so no task remains unfinished.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['content', 'activeForm', 'status'],
            properties: {
              content: { type: 'string', minLength: 1 },
              activeForm: { type: 'string', minLength: 1 },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
              },
            },
          },
        },
      },
    },
    isConcurrencySafe: false,
    prompt: PROMPT,
    async call(input: { todos?: unknown }) {
      // Array.isArray narrows input.todos to any[]; treat elements as unknown.
      const incoming = Array.isArray(input?.todos) ? input.todos : []

      const oldTodos = store.getAll()
      const next: TodoItem[] = []
      let allDone = incoming.length > 0

      for (const t of incoming) {
        if (!isRecord(t)) {
          return { data: 'Error: each todo must be an object', is_error: true }
        }
        const { content, activeForm } = t
        if (typeof content !== 'string' || content.trim() === '') {
          return { data: 'Error: each todo requires a non-empty content', is_error: true }
        }
        if (typeof activeForm !== 'string' || activeForm.trim() === '') {
          return { data: 'Error: each todo requires a non-empty activeForm', is_error: true }
        }
        const status = coerceStatus(t.status)
        if (status !== 'completed') allDone = false
        next.push({ content, activeForm, status })
      }

      const inProgressCount = next.filter((todo) => todo.status === 'in_progress').length
      if (!allDone && inProgressCount !== 1) {
        return {
          data: `Error: unfinished todo lists require exactly one in_progress task; received ${inProgressCount}`,
          is_error: true,
        }
      }

      store.set(allDone ? [] : next)
      const todos = store.getAll()
      const inProgress = todos.find((t) => t.status === 'in_progress')
      const state: TodoState = {
        todos,
        currentActiveForm: inProgress ? inProgress.activeForm : null,
      }
      await opts.onTodoUpdated?.(state)

      const base = renderTodos(todos)
      const shouldNudge = !allDone && countNewlyCompleted(oldTodos, next) >= 3
      return shouldNudge ? base + VERIFICATION_NUDGE : base
    },
  })
}
