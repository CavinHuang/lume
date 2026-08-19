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
    expect(CODEX_LIGHT_THEME.name).toBe(CODEX_LIGHT_THEME_NAME)
    expect(CODEX_LIGHT_THEME.type).toBe('light')
    expect(CODEX_LIGHT_THEME.colors?.['editor.background']).toBe('#ffffff')
    expect(CODEX_DARK_THEME.name).toBe(CODEX_DARK_THEME_NAME)
    expect(CODEX_DARK_THEME.type).toBe('dark')
    expect(CODEX_DARK_THEME.colors?.['editor.background']).toBe('#111111')
  })

  test('keeps representative theme token colors in both modes', () => {
    expect(CODEX_LIGHT_THEME.tokenColors).toEqual(expect.arrayContaining([
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#D53538' }) }),
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#008809' }) }),
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#751ED9' }) }),
    ]))
    expect(CODEX_DARK_THEME.tokenColors).toEqual(expect.arrayContaining([
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#F67576' }) }),
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#85df7b' }) }),
      expect.objectContaining({ settings: expect.objectContaining({ foreground: '#B06DFF' }) }),
    ]))
  })

  test('carries full official theme surface (per-language rules + semantic tokens)', () => {
    for (const theme of [CODEX_LIGHT_THEME, CODEX_DARK_THEME]) {
      // 完整主题：245 条 TextMate 规则 + 16 语义 token
      expect(theme.tokenColors).toHaveLength(245)
      expect(Object.keys(theme.semanticTokenColors ?? {})).toHaveLength(16)
    }
    expect(CODEX_LIGHT_THEME.semanticTokenColors).toMatchObject({ keyword: '#D53538', string: '#008809' })
    expect(CODEX_DARK_THEME.semanticTokenColors).toMatchObject({ keyword: '#F67576', string: '#85df7b' })
  })

  test('invalid tokens carry a red background in both modes', () => {
    // 前景为白，必须有底色否则浅色面板上不可见
    for (const theme of [CODEX_LIGHT_THEME, CODEX_DARK_THEME]) {
      const invalidRules = theme.tokenColors?.filter(
        (rule) => typeof rule.scope === 'string' && rule.scope.startsWith('invalid'),
      ) ?? []
      expect(invalidRules.length).toBeGreaterThan(0)
      for (const rule of invalidRules) {
        expect(rule.settings?.background).toBe('#e02e2a')
      }
    }
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
