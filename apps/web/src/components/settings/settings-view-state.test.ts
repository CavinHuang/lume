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
})
