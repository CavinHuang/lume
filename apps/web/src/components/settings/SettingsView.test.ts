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
      'browser',
      'workspaces',
      'memory',
      'reading',
      'permissions',
      'desktop-assistant',
      'shortcuts',
      'integrations',
      'im-integrations',
      'web-search',
      'voice-input',
      'data',
      'logs',
      'archive',
      'updates',
    ])
    expect(SETTINGS_PAGE_TITLES.memory).toBe('记忆设置')
    expect(SETTINGS_PAGE_SUBTITLES.memory).toBe('管理主动记忆、后台整理、召回与迁移诊断')
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
