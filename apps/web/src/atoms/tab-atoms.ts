import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { DesktopContextTarget } from '@lume/shared'

export type TabType = 'agent' | 'settings' | 'welcome' | 'automation' | 'skills' | 'reading' | 'lume' | 'file' | 'browser'
export type SettingsTab = 'channel' | 'agent' | 'mcp' | 'about'
export type FileTabSource = 'workspace' | 'thread' | 'local'

export interface Tab {
  id: string
  type: TabType
  title: string
  threadId?: string
  readOnly?: boolean
  settingsTab?: SettingsTab
  workspaceId?: string
  filePath?: string
  fileSource?: FileTabSource
  workspaceSlug?: string
  sourcePath?: string
  browserUrl?: string
  desktopContextTarget?: DesktopContextTarget
}

export const tabsAtom = atom<Tab[]>([])
export const activeTabIdAtom = atomWithStorage<string | null>('active-tab-id', null)
export const sidebarCollapsedAtom = atomWithStorage('sidebar-collapsed', false)
export const welcomePromptSeedAtom = atom<string | null>(null)
export const settingsInitialTabAtom = atom<string | null>(null)
export const archiveInitialViewAtom = atom<'archive' | 'trash' | null>(null)

export function setTabDesktopContextTarget(tabs: Tab[], tabId: string, target: DesktopContextTarget): Tab[] {
  return tabs.map((tab) => (
    tab.id === tabId
      ? { ...tab, desktopContextTarget: target }
      : tab
  ))
}
