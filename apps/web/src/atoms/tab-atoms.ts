import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export type TabType = 'agent' | 'settings' | 'welcome' | 'automation'
export type SettingsTab = 'channel' | 'agent' | 'mcp' | 'about'

export interface Tab {
  id: string
  type: TabType
  title: string
  threadId?: string
  settingsTab?: SettingsTab
  workspaceId?: string
}

export const tabsAtom = atom<Tab[]>([])
export const activeTabIdAtom = atomWithStorage<string | null>('active-tab-id', null)
export const sidebarCollapsedAtom = atomWithStorage('sidebar-collapsed', false)
