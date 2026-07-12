import type { Tab } from '@/atoms/tab-atoms'

export const DESKTOP_ASSISTANT_SETTINGS_TAB = 'desktop-assistant'
const SETTINGS_TAB_ID = '__settings__'

export function resolveOpenDesktopAssistantSettingsState(tabs: Tab[]): {
  activeTabId: string
  settingsInitialTab: typeof DESKTOP_ASSISTANT_SETTINGS_TAB
  tabs: Tab[]
} {
  return {
    activeTabId: SETTINGS_TAB_ID,
    settingsInitialTab: DESKTOP_ASSISTANT_SETTINGS_TAB,
    tabs: tabs.some((tab) => tab.id === SETTINGS_TAB_ID)
      ? tabs
      : [...tabs, { id: SETTINGS_TAB_ID, type: 'settings', title: '设置' }],
  }
}
