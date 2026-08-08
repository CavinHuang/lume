import { describe, expect, test } from 'bun:test'
import { isMacOS26OrLater, isMacOS26NativeIslandCapable } from './macos-version'

describe('macos-version', () => {
  test('Darwin 25 (macOS 26) 及以上为真', () => {
    expect(isMacOS26OrLater('25.0.0')).toBe(true)
    expect(isMacOS26OrLater('26.1.0')).toBe(true)
    expect(isMacOS26OrLater('24.0.0')).toBe(false) // macOS 15
  })
  test('非法 release 为假', () => {
    expect(isMacOS26OrLater('')).toBe(false)
    expect(isMacOS26OrLater('abc')).toBe(false)
  })
  test('native island 仅 macOS 26+ 可用；非 darwin 恒假', () => {
    expect(isMacOS26NativeIslandCapable('darwin', '25.0.0')).toBe(true)
    expect(isMacOS26NativeIslandCapable('darwin', '24.0.0')).toBe(false)
    expect(isMacOS26NativeIslandCapable('win32', '25.0.0')).toBe(false)
    expect(isMacOS26NativeIslandCapable('linux', '25.0.0')).toBe(false)
  })
})
