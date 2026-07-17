import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { CustomThemePalette } from '@lume/shared'
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
const styleProperties = new Map<string, string>()
const style = {
  setProperty(name: string, value: string) {
    styleProperties.set(name, value)
  },
  removeProperty(name: string) {
    styleProperties.delete(name)
  },
}

const customTheme: CustomThemePalette = {
  id: 'custom:quiet-forest',
  name: '静谧森林',
  light: {
    background: '#f7faf7',
    surface: '#ffffff',
    text: '#1f2a22',
    muted: '#6f7f73',
    accent: '#3f7d58',
  },
  dark: {
    background: '#111713',
    surface: '#1c261f',
    text: '#eef7f0',
    muted: '#91a697',
    accent: '#76c893',
  },
}

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
      documentElement: { dataset, style },
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
  localStorageMock.removeItem('lume:custom-theme-cache')
  delete dataset.themePalette
  delete dataset.customThemeId
  styleProperties.clear()
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

  test('accepts the mono, lavender, and olive palettes', () => {
    for (const palette of ['mono', 'lavender', 'olive'] as const) {
      localStorageMock.setItem('lume:theme-palette', palette)
      expect(readStoredThemePalette()).toBe(palette)
    }
  })

  test('stores and applies the selected palette', () => {
    setThemePalette('clay')

    expect(localStorageMock.getItem('lume:theme-palette')).toBe('clay')
    expect(dataset.themePalette).toBe('clay')
  })

  test('stores and applies a custom theme through shared custom variables', () => {
    setThemePalette(customTheme.id, [customTheme])

    expect(localStorageMock.getItem('lume:theme-palette')).toBe(customTheme.id)
    expect(dataset.themePalette).toBe('custom')
    expect(dataset.customThemeId).toBe(customTheme.id)
    expect(styleProperties.get('--lume-custom-light-background')).toBe('#f7faf7')
    expect(styleProperties.get('--lume-custom-dark-accent')).toBe('#76c893')
  })
})
