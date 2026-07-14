import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  readStoredThemeMode,
  readStoredThemePalette,
  resolveShouldUseDark,
  setThemePalette,
} from './theme-mode'

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
const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document
const dataset: Record<string, string> = {}

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: localStorageMock,
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { dataset },
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
  localStorageMock.removeItem('lume:theme-palette')
  delete dataset.themePalette
})

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
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

describe('theme palette runtime', () => {
  test('returns a stored palette and falls back to mint for invalid values', () => {
    localStorageMock.setItem('lume:theme-palette', 'ocean')
    expect(readStoredThemePalette()).toBe('ocean')

    localStorageMock.setItem('lume:theme-palette', 'unexpected')
    expect(readStoredThemePalette()).toBe('mint')
  })

  test('accepts the sakura and ember palettes', () => {
    localStorageMock.setItem('lume:theme-palette', 'sakura')
    expect(readStoredThemePalette()).toBe('sakura')

    localStorageMock.setItem('lume:theme-palette', 'ember')
    expect(readStoredThemePalette()).toBe('ember')
  })

  test('stores and applies the selected palette', () => {
    setThemePalette('clay')

    expect(localStorageMock.getItem('lume:theme-palette')).toBe('clay')
    expect(dataset.themePalette).toBe('clay')
  })
})
