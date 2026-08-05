import { useEffect, useState } from 'react'
import type * as React from 'react'
import {
  Settings,
} from 'lucide-react'
import { useSetAtom, useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { settingsInitialTabAtom, archiveInitialViewAtom } from '@/atoms'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { AgentSettings } from './AgentSettings'
import { AgentsSettings } from './AgentsSettings'
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
import { ArchiveSettings } from './ArchiveSettings'
import { SkillsSettings } from './SkillsSettings'
import { BrowserSettings } from './BrowserSettings'
import { LinkRuntimeSettings } from './LinkRuntimeSettings'
import {
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

  return (
    <div className="flex flex-1 min-w-0 min-h-0 gap-8 bg-[var(--background)]">
      <aside className="flex h-full min-h-0 w-[174px] shrink-0 flex-col bg-[var(--surface-1)] px-3 py-5 shadow-[6px_0_18px_-14px_hsl(var(--lume-shadow-panel)_/_0.32)]">
        <h1 className="mb-3 shrink-0 px-2.5 text-[22px] font-semibold leading-7 text-[var(--text-1)]">设置</h1>
        <ScrollArea className="min-h-0 flex-1 pr-1">
          <nav className="space-y-1.5">
            {SETTINGS_NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const selected = tab === item.id

              return (
                <Button
                  variant="ghost"
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    'flex h-9 w-full items-center justify-start gap-2.5 rounded-[8px] px-2.5 text-[13px] font-medium transition-colors',
                    selected
                      ? 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                      : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]'
                  )}
                >
                  <Icon size={16} strokeWidth={1.9} className="shrink-0" />
                  <span>{item.label}</span>
                </Button>
              )
            })}
          </nav>
        </ScrollArea>
      </aside>

      <ScrollArea className="flex-1 min-w-0 min-h-0 pr-8 pt-4 pb-0">
        <main className="min-w-0 py-5">
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
          {tab === 'link-runtime' && <LinkRuntimeSettings />}
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
          {tab === 'im-integrations' && <ImSettings />}
          {tab === 'web-search' && <WebSearchSettings />}
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
