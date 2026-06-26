import { describe, test, expect } from 'bun:test'
import { createTodoStore, createTodoTool } from './todo-tool.js'
import type { TodoItem } from './todo-tool.js'

const item = (
  content: string,
  status: TodoItem['status'] = 'in_progress',
  activeForm: string = content,
): TodoItem => ({ content, activeForm, status })

describe('createTodoStore', () => {
  test('two stores are isolated', () => {
    const a = createTodoStore()
    const b = createTodoStore()
    a.set([item('A1')])
    expect(b.getAll()).toEqual([])
    b.set([item('B1')])
    expect(a.getAll()).toHaveLength(1)
    expect(a.getAll()[0]!.content).toBe('A1')
  })

  test('set replaces; getAll returns a defensive copy', () => {
    const s = createTodoStore()
    s.set([item('A'), item('B')])
    const got = s.getAll()
    got[0]!.content = 'MUTATED'
    expect(s.getAll()[0]!.content).toBe('A')
  })
})

describe('createTodoTool', () => {
  test('throws without threadId', () => {
    expect(() => createTodoTool({} as never)).toThrow(/threadId/)
  })

  test('isConcurrencySafe is false', () => {
    const tool = createTodoTool({ threadId: 't1' })
    expect(tool.isConcurrencySafe()).toBe(false)
  })

  test('allDone clears the list', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    const res = await tool.call({ todos: [item('T1', 'completed')] })
    expect(res.content).toBe('No active todos.')
  })

  test('missing activeForm returns an error', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    const res = await tool.call({
      todos: [{ content: 'T1', status: 'in_progress' }],
    })
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('activeForm')
  })

  test('result is a compact single-state list', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    const res = await tool.call({
      todos: [
        item('Run tests', 'in_progress', 'Running tests'),
        item('Write docs', 'pending', 'Writing docs'),
      ],
    })
    expect(res.content).toBe('[~] Run tests\n[ ] Write docs')
  })
})
