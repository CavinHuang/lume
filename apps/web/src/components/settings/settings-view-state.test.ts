import { describe, expect, test } from 'bun:test'
import { SETTINGS_NAV_ITEMS } from './settings-view-state'

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

  test('includes application logs after update settings', () => {
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id)
    expect(ids).toContain('logs')
    expect(ids.indexOf('logs')).toBe(ids.indexOf('updates') + 1)
  })
})
