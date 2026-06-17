import { describe, expect, test } from 'bun:test'
import { SETTINGS_NAV_ITEMS, SETTINGS_PAGE_SUBTITLES, SETTINGS_PAGE_TITLES } from './settings-view-state'

describe('SettingsView metadata', () => {
  test('settings navigation includes supported settings sections', () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.id)).toEqual([
      'general',
      'appearance',
      'models',
      'agents',
      'skills',
      'workspaces',
      'memory',
      'reading',
      'permissions',
      'shortcuts',
      'integrations',
      'im-integrations',
      'web-search',
      'updates',
      'data',
      'logs',
      'archive',
    ])
    expect(SETTINGS_PAGE_TITLES.memory).toBe('记忆')
    expect(SETTINGS_PAGE_SUBTITLES.memory).toContain('工作区与全局记忆')
    expect(SETTINGS_PAGE_TITLES.permissions).toBe('权限管理')
    expect(SETTINGS_PAGE_SUBTITLES.permissions).toContain('权限模式')
    expect(SETTINGS_PAGE_TITLES.integrations).toBe('MCP')
    expect(SETTINGS_PAGE_TITLES['im-integrations']).toBe('IM 集成')
    expect(SETTINGS_PAGE_TITLES['web-search']).toBe('网络搜索')
    expect(SETTINGS_PAGE_TITLES.updates).toBe('版本与更新')
    expect(SETTINGS_PAGE_TITLES.data).toBe('数据管理')
    expect(SETTINGS_PAGE_TITLES.logs).toBe('应用日志')
    expect(SETTINGS_PAGE_SUBTITLES.logs).toContain('运行日志')
  })
})
