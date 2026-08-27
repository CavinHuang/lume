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

  test('prompt requires reconciling todos before the final answer', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    expect(await tool.prompt({} as any)).toContain('Before any final answer')
    expect(tool.description).toContain('no task remains unfinished')
  })

  test('allDone clears the list', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    const res = await tool.call({ todos: [item('T1', 'completed')] })
    expect(res.content).toBe('No active todos.')
  })

  test('empty todos resets the list instead of erroring (#538 reset-to-empty)', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    await tool.call({ todos: [item('T1')] })
    const res = await tool.call({ todos: [] })
    expect(res.is_error).toBeFalsy()
    expect(res.content).toBe('No active todos.')
  })

  test('TodoWrite is marked requiredDuringSkillScope (#542)', () => {
    const tool = createTodoTool({ threadId: 't1' })
    expect(tool.runtimeMetadata?.requiredDuringSkillScope).toBe(true)
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

  test('initialTodos restores the previous session state', async () => {
    const tool = createTodoTool({
      threadId: 't1',
      initialTodos: [
        item('A', 'completed', 'Doing A'),
        item('B', 'completed', 'Doing B'),
        item('C', 'completed', 'Doing C'),
        item('D', 'in_progress', 'Doing D'),
      ],
    })
    const res = await tool.call({
      todos: [
        item('A', 'completed', 'Doing A'),
        item('B', 'completed', 'Doing B'),
        item('C', 'completed', 'Doing C'),
        item('D', 'completed', 'Doing D'),
        item('E', 'in_progress', 'Doing E'),
      ],
    })

    expect(res.content).not.toContain('verification')
  })

  test('batch-completing 3+ tasks triggers verification nudge', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    // 先建立 5 个任务：1 in_progress + 4 pending
    await tool.call({
      todos: [
        item('A', 'in_progress', 'Doing A'),
        item('B', 'pending', 'Doing B'),
        item('C', 'pending', 'Doing C'),
        item('D', 'pending', 'Doing D'),
        item('E', 'pending', 'Doing E'),
      ],
    })
    // 一次把 B/C/D 标完成（A 仍 in_progress, E 仍 pending → not all done, 3 newly completed）
    const res = await tool.call({
      todos: [
        item('A', 'in_progress', 'Doing A'),
        item('B', 'completed', 'Doing B'),
        item('C', 'completed', 'Doing C'),
        item('D', 'completed', 'Doing D'),
        item('E', 'pending', 'Doing E'),
      ],
    })
    expect(res.content).toContain('verification')
  })

  test('all-done completion does NOT trigger nudge', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    await tool.call({
      todos: [
        item('A', 'in_progress', 'Doing A'),
        item('B', 'pending', 'Doing B'),
        item('C', 'pending', 'Doing C'),
      ],
    })
    // 一次性全完成 → allDone=true → 清空 → 不应 nudge
    const res = await tool.call({
      todos: [
        item('A', 'completed', 'Doing A'),
        item('B', 'completed', 'Doing B'),
        item('C', 'completed', 'Doing C'),
      ],
    })
    expect(res.content).toBe('No active todos.')
    expect(res.content).not.toContain('verification')
    // 重复全完成提交（oldTodos 已清空，钉死 !allDone 守卫的 I1 路径）
    const res2 = await tool.call({
      todos: [
        item('A', 'completed', 'Doing A'),
        item('B', 'completed', 'Doing B'),
        item('C', 'completed', 'Doing C'),
      ],
    })
    expect(res2.content).toBe('No active todos.')
    expect(res2.content).not.toContain('verification')
  })

  test('completing tasks one-at-a-time does NOT trigger nudge', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    await tool.call({ todos: [item('A', 'in_progress', 'Doing A'), item('B', 'pending', 'Doing B')] })
    const r1 = await tool.call({ todos: [item('A', 'completed', 'Doing A'), item('B', 'in_progress', 'Doing B')] })
    const r2 = await tool.call({ todos: [item('B', 'completed', 'Doing B')] })
    expect(r1.content).not.toContain('verification')
    expect(r2.content).not.toContain('verification')
  })

  test('batch-completing only 2 tasks does NOT trigger nudge', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    await tool.call({ todos: [item('A', 'in_progress', 'Doing A'), item('B', 'pending', 'Doing B')] })
    const res = await tool.call({
      todos: [item('A', 'completed', 'Doing A'), item('B', 'completed', 'Doing B')],
    })
    expect(res.content).not.toContain('verification')
  })

  test('onTodoUpdated fires with todos + currentActiveForm after call', async () => {
    let captured: { todos: TodoItem[]; currentActiveForm: string | null } | null = null
    const tool = createTodoTool({
      threadId: 't1',
      onTodoUpdated: (state) => { captured = state },
    })
    await tool.call({
      todos: [
        item('Run tests', 'in_progress', 'Running tests'),
        item('Write docs', 'pending', 'Writing docs'),
      ],
    })
    expect(captured).not.toBeNull()
    expect(captured!.todos).toHaveLength(2)
    expect(captured!.currentActiveForm).toBe('Running tests')
  })

  test('rejects unfinished lists without exactly one in_progress item', async () => {
    let captured: { todos: TodoItem[]; currentActiveForm: string | null } | null = null
    const tool = createTodoTool({
      threadId: 't1',
      onTodoUpdated: (state) => { captured = state },
    })
    const noneActive = await tool.call({ todos: [item('A', 'pending', 'Doing A')] })
    const multipleActive = await tool.call({
      todos: [item('A', 'in_progress', 'Doing A'), item('B', 'in_progress', 'Doing B')],
    })

    expect(noneActive.is_error).toBe(true)
    expect(noneActive.content).toContain('exactly one in_progress')
    expect(multipleActive.is_error).toBe(true)
    expect(captured).toBeNull()
  })
})
