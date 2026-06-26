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
export function createTodoTool(opts: { threadId: string }) {
  if (!opts?.threadId) {
    throw new Error('createTodoTool requires a threadId')
  }
  const store = createTodoStore()

  return defineTool({
    name: 'TodoWrite',
    description:
      'Update the session todo list. Always provide content (imperative) and activeForm (present continuous) for each task, and keep exactly one task in_progress at a time.',
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

      store.set(allDone ? [] : next)
      return renderTodos(store.getAll())
    },
  })
}
