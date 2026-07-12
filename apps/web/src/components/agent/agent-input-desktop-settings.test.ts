import { describe, expect, test } from 'bun:test'
import {
  DESKTOP_ASSISTANT_SETTINGS_TAB,
  resolveOpenDesktopAssistantSettingsState,
} from './agent-input-desktop-settings'

describe('agent-input desktop settings navigation', () => {
  test('opens desktop assistant settings in the existing settings tab', () => {
    expect(resolveOpenDesktopAssistantSettingsState([
      { id: '__settings__', type: 'settings', title: '设置' },
      { id: 'thread-1', type: 'agent', title: '项目' },
    ])).toEqual({
      activeTabId: '__settings__',
      settingsInitialTab: DESKTOP_ASSISTANT_SETTINGS_TAB,
      tabs: [
        { id: '__settings__', type: 'settings', title: '设置' },
        { id: 'thread-1', type: 'agent', title: '项目' },
      ],
    })
  })

  test('creates the settings tab when it is missing', () => {
    expect(resolveOpenDesktopAssistantSettingsState([
      { id: 'thread-1', type: 'agent', title: '项目' },
    ])).toEqual({
      activeTabId: '__settings__',
      settingsInitialTab: DESKTOP_ASSISTANT_SETTINGS_TAB,
      tabs: [
        { id: 'thread-1', type: 'agent', title: '项目' },
        { id: '__settings__', type: 'settings', title: '设置' },
      ],
    })
  })
})
