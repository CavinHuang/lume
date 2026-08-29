import { useEffect, useState } from 'react'
import type * as React from 'react'
import {
  ArrowLeft,
  Settings,
} from 'lucide-react'
import { useSetAtom, useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { settingsInitialTabAtom, archiveInitialViewAtom, tabsAtom, activeTabIdAtom } from '@/atoms'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { AgentSettings } from './AgentSettings'
import { AgentsSettings } from './AgentsSettings'
import { ConnectorSettings } from './ConnectorSettings'
import { McpSettings } from './McpSettings'
import { ImSettings } from './ImSettings'
import { PermissionSettings } from './PermissionSettings'
import { DesktopAssistantSettings } from './DesktopAssistantSettings'
import { WorkspacesSettings } from './WorkspacesSettings'
import { MemorySettings } from './MemorySettings'
import { ReadingSettings } from './ReadingSettings'
import { VersionUpdateSettings } from './VersionUpdateSettings'
import { DataManagementSettings } from './DataManagementSettings'
import { LogSettings } from './LogSettings'
import { WebSearchSettings } from './WebSearchSettings'
import { VoiceDictationSettings } from './VoiceDictationSettings'
import { ArchiveSettings } from './ArchiveSettings'
import { SkillsSettings } from './SkillsSettings'
import { BrowserSettings } from './BrowserSettings'
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  SETTINGS_PAGE_SUBTITLES,
  SETTINGS_PAGE_TITLES,
  type SettingsViewTab,
} from './settings-view-state'

import { Button } from '@/components/ui/button'
export function SettingsView() {
  const initialTab = useAtomValue(settingsInitialTabAtom)
  const clearInitialTab = useSetAtom(settingsInitialTabAtom)
  const archiveInitialView = useAtomValue(archiveInitialViewAtom)
  const clearArchiveInitialView = useSetAtom(archiveInitialViewAtom)
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const [tab, setTab] = useState<SettingsViewTab>(() => {
    if (initialTab && SETTINGS_NAV_ITEMS.some((item) => item.id === initialTab)) {
      return initialTab as SettingsViewTab
    }
    return 'general'
  })

  useEffect(() => {
    if (initialTab) {
      if (SETTINGS_NAV_ITEMS.some((item) => item.id === initialTab)) {
        setTab(initialTab as SettingsViewTab)
      }
      clearInitialTab(null)
      if (archiveInitialView) clearArchiveInitialView(null)
    }
  }, [initialTab, clearInitialTab, archiveInitialView, clearArchiveInitialView])
  const title = SETTINGS_PAGE_TITLES[tab]
  const subtitle = SETTINGS_PAGE_SUBTITLES[tab]
  const itemsById = new Map(SETTINGS_NAV_ITEMS.map((item) => [item.id, item]))

  const backToWorkspace = () => {
    const previous = tabs.filter((item) => item.type !== 'settings')
    const target = previous.at(-1)
    if (target) {
      setActiveTabId(target.id)
      return
    }
    // 没有任何工作区 tab 时，回到「新会话」首页
    setTabs((prev) => [{ id: '__welcome__', type: 'welcome' as const, title: '新会话' }, ...prev])
    setActiveTabId('__welcome__')
  }

  return (
    <div className="flex h-full w-full min-w-0 gap-8 bg-[var(--lume-bg-rail)]">
      <aside className="flex h-full min-h-0 w-[286px] min-w-[286px] shrink-0 flex-col bg-[var(--lume-bg-rail)] pl-2 pb-5 pt-3">
        <Button
          variant="ghost"
          type="button"
          onClick={backToWorkspace}
          className="mb-2 mr-2 flex h-8 w-full shrink-0 items-center justify-start gap-2 rounded-[8px] text-[13px] font-medium text-[var(--text-2)]"
        >
          <ArrowLeft size={16} strokeWidth={1.9} className="shrink-0" />
          <span>返回工作区</span>
        </Button>
        <div className="min-h-0 flex-1 overflow-y-auto pr-2 scrollbar-none">
          <nav className="space-y-4">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="mb-1 text-[11px] font-medium leading-4 text-[var(--text-3)]">{group.label}</div>
                <div className="space-y-1">
                  {group.items.map((id) => {
                    const item = itemsById.get(id)
                    if (!item) return null
                    const Icon = item.icon
                    const selected = tab === id

                    return (
                      <Button
                        variant="ghost"
                        key={id}
                        type="button"
                        onClick={() => setTab(id)}
                        className={cn(
                          'flex h-9 w-full items-center justify-start gap-2.5 rounded-[8px] text-[13px] font-medium transition-colors',
                          selected
                            ? 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                            : 'text-[var(--text-2)]'
                        )}
                      >
                        <Icon size={16} strokeWidth={1.9} className="shrink-0" />
                        <span>{item.label}</span>
                      </Button>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>
        </div>
      </aside>

      <ScrollArea className="min-h-0 flex-1 overflow-hidden rounded-l-[16px] bg-[var(--background)] pt-4 pb-0">
        <main className="mx-auto w-full max-w-4xl px-6 py-5">
          <div className="mb-4">
            <h2 className="text-[22px] font-semibold leading-7 text-[var(--text-1)]">{title}</h2>
            <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">{subtitle}</p>
          </div>
          {tab === 'general' && <GeneralSettings />}
          {tab === 'appearance' && <AppearanceSettings />}
          {tab === 'models' && <AgentSettings />}
          {tab === 'agents' && <AgentsSettings />}
          {tab === 'skills' && <SkillsSettings />}
          {tab === 'browser' && <BrowserSettings onOpenSkills={() => setTab('skills')} />}
          {tab === 'workspaces' && <WorkspacesSettings />}
          {tab === 'memory' && <MemorySettings />}
          {tab === 'reading' && <ReadingSettings />}
          {tab === 'permissions' && <PermissionSettings />}
          {tab === 'desktop-assistant' && <DesktopAssistantSettings />}
          {tab === 'shortcuts' && (
            <SettingsPlaceholder
              title="快捷键"
              desc="快捷键配置会在后续版本回到这里，自动化入口已移到侧边栏。"
            />
          )}
          {tab === 'integrations' && <McpSettings />}
          {tab === 'im-integrations' && (
            <div className="space-y-4">
              <ConnectorSettings />
              <ImSettings />
            </div>
          )}
          {tab === 'web-search' && <WebSearchSettings />}
          {tab === 'voice-input' && <VoiceDictationSettings />}
          {tab === 'updates' && <VersionUpdateSettings />}
          {tab === 'data' && <DataManagementSettings />}
          {tab === 'logs' && <LogSettings />}
          {tab === 'archive' && <ArchiveSettings initialView={archiveInitialView ?? undefined} />}
        </main>
      </ScrollArea>
    </div>
  )
}

function SettingsContentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="lume-panel overflow-hidden">
      {children}
    </div>
  )
}

function SettingsPlaceholder({ title, desc }: { title: string; desc: string }) {
  return (
    <SettingsContentShell>
      <div className="flex min-h-[280px] flex-col items-center justify-center p-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-[12px] bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface-2))] text-[var(--brand)]">
          <Settings size={20} />
        </div>
        <h2 className="mt-4 text-[16px] font-semibold text-[var(--text-1)]">{title}</h2>
        <p className="mt-2 max-w-[360px] text-[13px] leading-6 text-[var(--text-3)]">{desc}</p>
      </div>
    </SettingsContentShell>
  )
}
