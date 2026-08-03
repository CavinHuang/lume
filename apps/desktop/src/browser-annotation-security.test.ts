import { describe, expect, test } from 'bun:test'
import { isBrowserAnnotationPopupCommand, isSafeBrowserAnnotationThreadId } from './browser-annotation-security'

describe('browser annotation popup security', () => {
  test('allows only the narrow editor command set', () => {
    expect(isBrowserAnnotationPopupCommand('add')).toBe(true)
    expect(isBrowserAnnotationPopupCommand('send')).toBe(true)
    expect(isBrowserAnnotationPopupCommand('sidecar_call')).toBe(false)
    expect(isBrowserAnnotationPopupCommand('read_clipboard_text')).toBe(false)
    expect(isBrowserAnnotationPopupCommand({})).toBe(false)
  })

  test('accepts only filesystem-safe bounded annotation thread ids', () => {
    expect(isSafeBrowserAnnotationThreadId('thread-1._a')).toBe(true)
    expect(isSafeBrowserAnnotationThreadId('../thread')).toBe(false)
    expect(isSafeBrowserAnnotationThreadId('thread/child')).toBe(false)
    expect(isSafeBrowserAnnotationThreadId('x'.repeat(201))).toBe(false)
  })
})
