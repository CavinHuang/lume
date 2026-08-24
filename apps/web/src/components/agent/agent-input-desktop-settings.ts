
import { type Tab } from '@/atoms'
export const DESKTOP_ASSISTANT_SETTINGS_TAB = 'desktop-assistant'
const SETTINGS_TAB_ID = '__settings__'

export function resolveOpenDesktopAssistantSettingsState(
  tabs: Tab[],
  settingsInitialTab: string = DESKTOP_ASSISTANT_SETTINGS_TAB,
): {
  activeTabId: string
  settingsInitialTab: string
  tabs: Tab[]
} {
  return {
    activeTabId: SETTINGS_TAB_ID,
    settingsInitialTab,
    tabs: tabs.some((tab) => tab.id === SETTINGS_TAB_ID)
      ? tabs
      : [...tabs, { id: SETTINGS_TAB_ID, type: 'settings', title: '设置' }],
  }
}
