import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readStoredThemeMode, resolveShouldUseDark } from './theme-mode'

const storage = new Map<string, string>()
const localStorageMock = {
  getItem(key: string) {
    return storage.has(key) ? storage.get(key)! : null
  },
  setItem(key: string, value: string) {
    storage.set(key, value)
  },
  removeItem(key: string) {
    storage.delete(key)
  },
  clear() {
    storage.clear()
  },
}
const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: localStorageMock,
    },
  })
})

describe('resolveShouldUseDark', () => {
  test('uses explicit dark mode regardless of system preference', () => {
    expect(resolveShouldUseDark('dark', false)).toBe(true)
  })

  test('uses explicit light mode regardless of system preference', () => {
    expect(resolveShouldUseDark('light', true)).toBe(false)
  })

  test('follows system preference in system mode', () => {
    expect(resolveShouldUseDark('system', true)).toBe(true)
    expect(resolveShouldUseDark('system', false)).toBe(false)
  })
})

afterEach(() => {
  localStorageMock.removeItem('lume:theme-mode')
})

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
})

describe('readStoredThemeMode', () => {
  test('returns a stored explicit theme mode', () => {
    localStorageMock.setItem('lume:theme-mode', 'dark')
    expect(readStoredThemeMode()).toBe('dark')
  })

  test('falls back to system for invalid storage values', () => {
    localStorageMock.setItem('lume:theme-mode', 'unexpected')
    expect(readStoredThemeMode()).toBe('system')
  })
})
