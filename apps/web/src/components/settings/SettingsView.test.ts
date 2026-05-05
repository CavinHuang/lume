import { describe, expect, test } from 'bun:test'
import { SETTINGS_NAV_ITEMS, SETTINGS_PAGE_SUBTITLES, SETTINGS_PAGE_TITLES } from './settings-view-state'

describe('SettingsView metadata', () => {
  test('settings navigation includes memory between workspaces and files', () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.id)).toEqual([
      'general',
      'appearance',
      'models',
      'workspaces',
      'memory',
      'files',
      'shortcuts',
      'integrations',
      'updates',
    ])
    expect(SETTINGS_PAGE_TITLES.memory).toBe('记忆')
    expect(SETTINGS_PAGE_SUBTITLES.memory).toContain('工作区与全局记忆')
    expect(SETTINGS_PAGE_TITLES.updates).toBe('版本与更新')
  })
})
