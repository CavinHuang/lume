import { describe, expect, test } from 'bun:test'
import {
  CACHE_CLEANUP_OPTIONS,
  GENERAL_SETTINGS_DEFAULTS,
  PROXY_MODE_OPTIONS,
  SETTINGS_NAV_ITEMS,
  THEME_MODE_OPTIONS,
  createDefaultCacheCleanupSelection,
  hasSelectedCacheCleanup,
  normalizeProxyDraft,
  mergeGeneralSettings,
} from './general-settings-state'

describe('general settings state', () => {
  test('general settings nav metadata places 常规设置 first', () => {
    expect(SETTINGS_NAV_ITEMS[0]).toMatchObject({
      id: 'general',
      label: '常规设置',
    })
  })

  test('theme mode options are system/light/dark', () => {
    expect(THEME_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'system',
      'light',
      'dark',
    ])
  })

  test('proxy mode options expose off/system/custom modes', () => {
    expect(PROXY_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'off',
      'system',
      'custom',
    ])
  })

  test('cache cleanup defaults all three safe caches to selected', () => {
    expect(CACHE_CLEANUP_OPTIONS.map((option) => option.key)).toEqual([
      'frontendTemp',
      'previewRender',
      'logs',
    ])
    expect(createDefaultCacheCleanupSelection()).toEqual({
      frontendTemp: true,
      previewRender: true,
      logs: true,
    })
  })

  test('general settings defaults stay app-wide and conservative', () => {
    expect(GENERAL_SETTINGS_DEFAULTS).toEqual({
      themeMode: 'system',
      userProfile: {
        displayName: '',
      },
      windowBehavior: {
        minimizeToTray: false,
        closeToTray: false,
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
      userProfile: {
        displayName: '',
      },
      windowBehavior: {
        minimizeToTray: false,
        closeToTray: true,
      },
    })
  })

  test('mergeGeneralSettings trims user display name and preserves window behavior', () => {
    expect(mergeGeneralSettings({
      themeMode: 'dark',
      userProfile: {
        displayName: 'Cavin',
      },
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: false,
      },
    }, {
      userProfile: {
        displayName: '  Minator Huang  ',
      },
    })).toEqual({
      themeMode: 'dark',
      userProfile: {
        displayName: 'Minator Huang',
      },
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: false,
      },
    })
  })

  test('hasSelectedCacheCleanup returns false when every safe cache option is deselected', () => {
    expect(hasSelectedCacheCleanup({
      frontendTemp: false,
      previewRender: false,
      logs: false,
    })).toBe(false)
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
