import { describe, expect, test } from 'bun:test'
import {
  detectIsCustomWindowControlsPlatform,
  detectIsMacosDesktopShell,
} from './platform'

describe('detectIsMacosDesktopShell', () => {
  test('macOS 桌面端为 true', () => {
    expect(detectIsMacosDesktopShell('MacIntel', true)).toBe(true)
  })
  test('macOS 但非桌面端为 false', () => {
    expect(detectIsMacosDesktopShell('MacIntel', false)).toBe(false)
  })
  test('Windows 桌面端为 false', () => {
    expect(detectIsMacosDesktopShell('Win32', true)).toBe(false)
  })
  test('userAgent 缺失时为 false', () => {
    expect(detectIsMacosDesktopShell(undefined, true)).toBe(false)
  })
})

describe('detectIsCustomWindowControlsPlatform', () => {
  test('Windows 桌面端为 true（需自绘按钮）', () => {
    expect(detectIsCustomWindowControlsPlatform('Win32', true)).toBe(true)
  })
  test('Linux 桌面端为 true', () => {
    expect(detectIsCustomWindowControlsPlatform('Linux x86_64', true)).toBe(true)
  })
  test('macOS 桌面端为 false（保留原生交通灯）', () => {
    expect(detectIsCustomWindowControlsPlatform('MacIntel', true)).toBe(false)
  })
  test('浏览器（非桌面端）为 false', () => {
    expect(detectIsCustomWindowControlsPlatform('Win32', false)).toBe(false)
  })
})
