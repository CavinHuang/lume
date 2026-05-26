import { describe, expect, test } from 'bun:test'
import { SETTINGS_NAV_ITEMS, SETTINGS_PAGE_SUBTITLES, SETTINGS_PAGE_TITLES } from './settings-view-state'

describe('SettingsView metadata', () => {
  test('settings navigation includes memory between workspaces and files', () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.id)).toEqual([
      'general',
      'appearance',
      'models',
      'agents',
      'workspaces',
      'memory',
      'files',
      'shortcuts',
      'integrations',
      'im-integrations',
      'updates',
    ])
    expect(SETTINGS_PAGE_TITLES.memory).toBe('记忆')
    expect(SETTINGS_PAGE_SUBTITLES.memory).toContain('工作区与全局记忆')
    expect(SETTINGS_PAGE_TITLES.integrations).toBe('MCP')
    expect(SETTINGS_PAGE_TITLES['im-integrations']).toBe('IM 集成')
    expect(SETTINGS_PAGE_TITLES.updates).toBe('版本与更新')
  })
})
