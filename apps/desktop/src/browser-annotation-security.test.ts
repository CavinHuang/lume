import { describe, expect, test } from 'bun:test'
import { isSafeBrowserAnnotationThreadId } from './browser-annotation-security'

describe('browser annotation thread id security', () => {
  test('accepts only filesystem-safe bounded annotation thread ids', () => {
    expect(isSafeBrowserAnnotationThreadId('thread-1._a')).toBe(true)
    expect(isSafeBrowserAnnotationThreadId('../thread')).toBe(false)
    expect(isSafeBrowserAnnotationThreadId('thread/child')).toBe(false)
    expect(isSafeBrowserAnnotationThreadId('x'.repeat(201))).toBe(false)
  })
})
