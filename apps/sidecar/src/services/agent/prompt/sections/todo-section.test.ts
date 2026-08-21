import { describe, test, expect } from 'bun:test'
import { buildTodoSection } from './todo-section'

describe('buildTodoSection', () => {
  test('returns a string starting with a markdown heading', () => {
    const out = buildTodoSection()
    expect(typeof out).toBe('string')
    expect(out.startsWith('## ')).toBe(true)
  })
  test('scopes usage to multi-step work', () => {
    expect(buildTodoSection()).toContain('multi-step work')
    expect(buildTodoSection()).toContain('skip for single trivial or purely conversational requests')
  })
  test('contains the exactly-one-in_progress rule', () => {
    expect(buildTodoSection()).toContain('exactly one task in_progress')
  })
  test('tasks are marked completed immediately', () => {
    expect(buildTodoSection()).toContain('the moment they are done')
  })
})
