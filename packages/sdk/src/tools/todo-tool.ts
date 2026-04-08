/**
 * TodoWriteTool - Session todo/checklist management
 *
 * Aligns with the Claude-style shape where the model submits the full
 * todo list on each write. Legacy action-based operations are still accepted.
 */

import type { ToolDefinition, ToolResult } from '../types.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  id: string
  content: string
  activeForm?: string
  status: TodoStatus
  priority?: 'high' | 'medium' | 'low'
  text?: string
  done?: boolean
}

const todoList: TodoItem[] = []
let todoCounter = 0

function syncCompatFields(todo: TodoItem): TodoItem {
  return {
    ...todo,
    text: todo.content,
    done: todo.status === 'completed',
  }
}

function normalizeTodos(inputTodos: any[]): TodoItem[] {
  return inputTodos.map((todo) => {
    const status = todo.status || (todo.done ? 'completed' : 'pending')
    const id = String(todo.id || `todo_${++todoCounter}`)
    return syncCompatFields({
      id,
      content: String(todo.content || todo.text || ''),
      activeForm:
        typeof todo.activeForm === 'string' ? todo.activeForm : undefined,
      status,
      priority: todo.priority,
    })
  })
}

function listTodosText(): string {
  if (todoList.length === 0) return 'No todos.'
  return todoList
    .map((todo) => {
      const marker =
        todo.status === 'completed'
          ? '[x]'
          : todo.status === 'in_progress'
            ? '[~]'
            : '[ ]'
      return `${marker} ${todo.id} ${todo.content}${todo.priority ? ` (${todo.priority})` : ''}`
        + (todo.activeForm ? ` <${todo.activeForm}>` : '')
    })
    .join('\n')
}

export function getTodos(): TodoItem[] {
  return todoList.map((todo) => ({ ...todo }))
}

export function clearTodos(): void {
  todoList.length = 0
  todoCounter = 0
}

export const TodoWriteTool: ToolDefinition = {
  name: 'TodoWrite',
  description:
    'Replace the session todo list with an updated checklist, or use the legacy action-based API for compatibility.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full updated todo list.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            text: { type: 'string' },
            activeForm: { type: 'string' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
            done: { type: 'boolean' },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
          },
        },
      },

      // Backward-compatible shape
      action: {
        type: 'string',
        enum: ['add', 'toggle', 'remove', 'list', 'clear'],
      },
      text: { type: 'string' },
      id: { type: 'string' },
      priority: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
      },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'Update the session todo checklist by writing the full desired list.'
  },
  async call(input: any): Promise<ToolResult> {
    if (Array.isArray(input?.todos)) {
      const oldTodos = getTodos()
      const newTodos = normalizeTodos(input.todos)
      todoList.length = 0
      todoList.push(...newTodos)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content:
          `Todos updated successfully.\n\nBefore:\n${oldTodos.length ? oldTodos.map((todo) => `${todo.id}: ${todo.content} [${todo.status}]`).join('\n') : '(empty)'}\n\nAfter:\n${listTodosText()}`,
      }
    }

    switch (input.action) {
      case 'add': {
        if (!input.text) {
          return { type: 'tool_result', tool_use_id: '', content: 'text required', is_error: true }
        }
        const item = syncCompatFields({
          id: `todo_${++todoCounter}`,
          content: input.text,
          activeForm: input.text,
          status: 'pending',
          priority: input.priority,
        })
        todoList.push(item)
        return { type: 'tool_result', tool_use_id: '', content: `Todo added: ${item.id} "${item.content}"` }
      }
      case 'toggle': {
        const item = todoList.find((todo) => todo.id === String(input.id))
        if (!item) {
          return { type: 'tool_result', tool_use_id: '', content: `Todo ${input.id} not found`, is_error: true }
        }
        item.status = item.status === 'completed' ? 'pending' : 'completed'
        item.done = item.status === 'completed'
        return { type: 'tool_result', tool_use_id: '', content: `Todo ${item.id} ${item.status}` }
      }
      case 'remove': {
        const idx = todoList.findIndex((todo) => todo.id === String(input.id))
        if (idx === -1) {
          return { type: 'tool_result', tool_use_id: '', content: `Todo ${input.id} not found`, is_error: true }
        }
        const [removed] = todoList.splice(idx, 1)
        return { type: 'tool_result', tool_use_id: '', content: `Todo removed: ${removed.id}` }
      }
      case 'clear': {
        clearTodos()
        return { type: 'tool_result', tool_use_id: '', content: 'All todos cleared.' }
      }
      case 'list': {
        return { type: 'tool_result', tool_use_id: '', content: listTodosText() }
      }
      default:
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: 'Error: todos array or valid legacy action is required',
          is_error: true,
        }
    }
  },
}
