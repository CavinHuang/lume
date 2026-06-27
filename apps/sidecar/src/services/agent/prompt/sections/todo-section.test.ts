import { describe, test, expect } from 'bun:test'
import { buildTodoSection } from './todo-section'

describe('buildTodoSection', () => {
  test('returns a string starting with a markdown heading', () => {
    const out = buildTodoSection()
    expect(typeof out).toBe('string')
    expect(out.startsWith('## ')).toBe(true)
  })
  test('contains the exactly-one-in_progress rule', () => {
    expect(buildTodoSection()).toContain('EXACTLY ONE task in_progress')
  })
  test('contains the do-not-batch rule', () => {
    expect(buildTodoSection()).toContain('do not batch')
  })
  test('contains the blocked-creates-new-task rule', () => {
    expect(buildTodoSection()).toContain('blocked')
    expect(buildTodoSection()).toContain('new task')
  })
  test('requires both content and activeForm', () => {
    expect(buildTodoSection()).toContain('activeForm')
  })
})
