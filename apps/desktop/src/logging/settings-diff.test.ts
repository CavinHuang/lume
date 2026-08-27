import { describe, expect, test } from 'bun:test'
import { stableStringify } from './settings-diff'

describe('stableStringify (#758)', () => {
  test('嵌套对象键序无关', () => {
    expect(stableStringify({ a: 1, b: { x: 1, y: 2 } })).toBe(stableStringify({ b: { y: 2, x: 1 }, a: 1 }))
  })

  test('值变化可检出', () => {
    expect(stableStringify({ fileLevel: 'info' })).not.toBe(stableStringify({ fileLevel: 'warn' }))
  })

  test('数组顺序仍是语义（重排视为变更）', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })
})
