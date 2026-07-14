import { describe, expect, test } from 'bun:test'
import {
  GENERAL_SETTINGS_DEFAULTS,
  PROXY_MODE_OPTIONS,
  THEME_MODE_OPTIONS,
  THEME_PALETTE_OPTIONS,
  normalizeProxyDraft,
  mergeGeneralSettings,
} from './general-settings-state'

describe('general settings state', () => {
  test('theme mode options are system/light/dark', () => {
    expect(THEME_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'system',
      'light',
      'dark',
    ])
  })

  test('theme palette options expose all four approved palettes', () => {
    expect(THEME_PALETTE_OPTIONS.map((option) => option.value)).toEqual([
      'mint',
      'iris',
      'clay',
      'ocean',
    ])
  })

  test('proxy mode options expose off/system/custom modes', () => {
    expect(PROXY_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'off',
      'system',
      'custom',
    ])
  })

  test('general settings defaults stay app-wide and conservative', () => {
    expect(GENERAL_SETTINGS_DEFAULTS).toEqual({
      themeMode: 'system',
      themePalette: 'mint',
      agentMessageDisplayMode: 'minimal',
      windowBehavior: {
        minimizeToTray: false,
        closeToTray: false,
        showTray: true,
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null,
      },
    })
  })

  test('mergeGeneralSettings applies partial window behavior updates without losing sibling flags', () => {
    expect(mergeGeneralSettings(GENERAL_SETTINGS_DEFAULTS, {
      windowBehavior: {
        closeToTray: true,
      },
    })).toEqual({
      themeMode: 'system',
      themePalette: 'mint',
      agentMessageDisplayMode: 'minimal',
      windowBehavior: {
        minimizeToTray: false,
        closeToTray: true,
        showTray: true,
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null,
      },
    })
  })

  test('mergeGeneralSettings preserves window behavior when only theme changes', () => {
    expect(mergeGeneralSettings({
      themeMode: 'dark',
      themePalette: 'iris',
      agentMessageDisplayMode: 'minimal',
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: false,
        showTray: true,
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null,
      },
    }, {
      themeMode: 'light',
    })).toEqual({
      themeMode: 'light',
      themePalette: 'iris',
      agentMessageDisplayMode: 'minimal',
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: false,
        showTray: true,
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null,
      },
    })
  })

  test('mergeGeneralSettings updates palette without changing theme mode', () => {
    const merged = mergeGeneralSettings(GENERAL_SETTINGS_DEFAULTS, {
      themePalette: 'ocean',
    })

    expect(merged.themeMode).toBe('system')
    expect(merged.themePalette).toBe('ocean')
  })

  test('mergeGeneralSettings applies partial update settings without losing sibling flags', () => {
    expect(mergeGeneralSettings(GENERAL_SETTINGS_DEFAULTS, {
      updateSettings: {
        notifyAfterDownload: false,
        lastUpdateCheckAt: '2026-05-05T03:30:00.000Z',
      },
    }).updateSettings).toEqual({
      autoCheckUpdates: true,
      notifyAfterDownload: false,
      installOnlyWhenIdle: true,
      lastUpdateCheckAt: '2026-05-05T03:30:00.000Z',
    })
  })

  test('normalizeProxyDraft disables proxy when mode is off and trims custom values', () => {
    expect(normalizeProxyDraft({
      version: 1,
      enabled: true,
      mode: 'off',
      httpProxy: ' http://127.0.0.1:7890 ',
      httpsProxy: ' ',
      noProxy: ' localhost ',
    })).toEqual({
      version: 1,
      enabled: false,
      mode: 'off',
      httpProxy: 'http://127.0.0.1:7890',
      noProxy: 'localhost',
    })
  })
})
