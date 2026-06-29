import { describe, expect, test } from 'bun:test'
import { resolveUnhandledRejectionToast } from './global-error-toast'

// sidecar 错误经 Rust `Result<_, String>` → invoke 以字符串拒绝；Error/对象为兜底。
// 中止类预期错误跳过；空 reason 跳过。
describe('resolveUnhandledRejectionToast', () => {
  test('returns sidecar string rejections as-is', () => {
    expect(resolveUnhandledRejectionToast('工具权限确认会话不匹配')).toBe('工具权限确认会话不匹配')
    expect(resolveUnhandledRejectionToast('未找到待确认的工具权限请求')).toBe('未找到待确认的工具权限请求')
  })

  test('extracts message from Error', () => {
    expect(resolveUnhandledRejectionToast(new Error('boom'))).toBe('boom')
  })

  test('extracts message from object with .message', () => {
    expect(resolveUnhandledRejectionToast({ message: '对象错误', code: 1 })).toBe('对象错误')
  })

  test('skips AbortError and "aborted" (user-initiated stop)', () => {
    const abort = new DOMException('aborted', 'AbortError')
    expect(resolveUnhandledRejectionToast(abort)).toBeNull()
    expect(resolveUnhandledRejectionToast('aborted')).toBeNull()
    expect(resolveUnhandledRejectionToast('ABORTED')).toBeNull()
  })

  test('skips null/undefined/empty', () => {
    expect(resolveUnhandledRejectionToast(null)).toBeNull()
    expect(resolveUnhandledRejectionToast(undefined)).toBeNull()
    expect(resolveUnhandledRejectionToast('')).toBeNull()
    expect(resolveUnhandledRejectionToast(new Error(''))).toBeNull()
  })

  test('does not match "abort" substring inside unrelated errors', () => {
    expect(resolveUnhandledRejectionToast('abort handler cleanup failed')).toBe('abort handler cleanup failed')
  })
})
