import { describe, test, expect } from 'bun:test'
import { buildTodoSection } from './todo-section'

describe('buildTodoSection', () => {
  test('returns a string starting with a markdown heading', () => {
    const out = buildTodoSection()
    expect(typeof out).toBe('string')
    expect(out.startsWith('## ')).toBe(true)
  })
  test('scopes usage to multi-step work', () => {
    expect(buildTodoSection()).toContain('多步工作')
    expect(buildTodoSection()).toContain('单一琐事或纯对话请求不要使用')
  })
  test('contains the exactly-one-in_progress rule', () => {
    expect(buildTodoSection()).toContain('只保留一个 in_progress 任务')
  })
  test('tasks are marked completed immediately', () => {
    expect(buildTodoSection()).toContain('完成的当下立即标记 completed')
  })
})
