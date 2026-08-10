import { describe, expect, test } from 'bun:test'
import { SETTINGS_NAV_ITEMS, SETTINGS_PAGE_TITLES, SETTINGS_PAGE_SUBTITLES } from './settings-view-state'

describe('settings view state', () => {
  test('places Agents after model settings', () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.id).slice(0, 4)).toEqual([
      'general',
      'appearance',
      'models',
      'agents',
    ])
  })

  test('keeps MCP and IM integration settings as separate navigation items', () => {
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id)
    expect(ids).toContain('integrations')
    expect(ids).toContain('im-integrations')
    expect(ids.indexOf('im-integrations')).toBe(ids.indexOf('integrations') + 1)
  })

  test('places permission management before integrations', () => {
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id)
    expect(ids).toContain('permissions')
    expect(ids.indexOf('permissions')).toBeLessThan(ids.indexOf('integrations'))
  })

  test('places Reading near Memory instead of under integrations', () => {
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id)
    expect(ids.indexOf('reading')).toBe(ids.indexOf('memory') + 1)
    expect(ids.indexOf('reading')).toBeLessThan(ids.indexOf('integrations'))
  })

  test('keeps data management immediately before application logs', () => {
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id)
    expect(ids).toContain('logs')
    expect(ids.indexOf('logs')).toBe(ids.indexOf('data') + 1)
  })

  test('places update settings last', () => {
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id)
    expect(ids.at(-1)).toBe('updates')
  })

  test('data page title is 数据管理', () => {
    expect(SETTINGS_PAGE_TITLES.data).toBe('数据管理')
  })

  test('data page subtitle describes storage, cleanup and export', () => {
    expect(SETTINGS_PAGE_SUBTITLES.data).toBe('查看存储用量、安全清理与全量数据导出')
  })

  test('places skills between agents and workspaces', () => {
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id)
    expect(ids).toContain('skills')
    expect(ids.indexOf('skills')).toBe(ids.indexOf('agents') + 1)
    expect(ids.indexOf('skills')).toBeLessThan(ids.indexOf('workspaces'))
  })

  test('skills page title is 技能管理', () => {
    expect(SETTINGS_PAGE_TITLES.skills).toBe('技能管理')
  })

  test('skills page subtitle is 管理自定义技能、触发条件与工具权限', () => {
    expect(SETTINGS_PAGE_SUBTITLES.skills).toBe('管理自定义技能、触发条件与工具权限')
  })

  test('memory page is advanced settings rather than a second memory center', () => {
    expect(SETTINGS_NAV_ITEMS.find((item) => item.id === 'memory')?.label).toBe('记忆设置')
    expect(SETTINGS_PAGE_TITLES.memory).toBe('记忆设置')
    expect(SETTINGS_PAGE_SUBTITLES.memory).toBe('管理主动记忆、后台整理、召回与迁移诊断')
  })
})
