import { describe, expect, test } from 'bun:test'
import {
  CODEX_DARK_THEME,
  CODEX_DARK_THEME_NAME,
  CODEX_LIGHT_THEME,
  CODEX_LIGHT_THEME_NAME,
} from './codex-themes'
import { getCodeThemeName } from './theme-runtime'

describe('Codex syntax themes', () => {
  test('registers stable light and dark theme names', () => {
    expect(CODEX_LIGHT_THEME).toMatchObject({
      name: CODEX_LIGHT_THEME_NAME,
      type: 'light',
      colors: { 'editor.background': '#ffffff' },
    })
    expect(CODEX_DARK_THEME).toMatchObject({
      name: CODEX_DARK_THEME_NAME,
      type: 'dark',
      colors: { 'editor.background': '#0d0d0d' },
    })
  })

  test('keeps representative Codex token colors in both modes', () => {
    expect(CODEX_LIGHT_THEME.tokenColors).toEqual(expect.arrayContaining([
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#a626a4' }) }),
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#50a14f' }) }),
    ]))
    expect(CODEX_DARK_THEME.tokenColors).toEqual(expect.arrayContaining([
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#2e95d3' }) }),
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#00a67d' }) }),
    ]))
  })

  test('resolves the active theme from the root dark class', () => {
    const originalDocument = globalThis.document
    let dark = false
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { classList: { contains: () => dark } } },
    })
    try {
      expect(getCodeThemeName()).toBe(CODEX_LIGHT_THEME_NAME)
      dark = true
      expect(getCodeThemeName()).toBe(CODEX_DARK_THEME_NAME)
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      })
    }
  })
})
