import { useState } from 'react'
import type * as React from 'react'
import {
  Box,
  Cloud,
  Cog,
  Keyboard,
  Palette,
  Puzzle,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { GeneralSettings } from './GeneralSettings'
import { AgentSettings } from './AgentSettings'
import { McpSettings } from './McpSettings'
import { SkillsSettings } from './SkillsSettings'
import { WorkspacesSettings } from './WorkspacesSettings'
import { AutomationSettings } from '../automation/AutomationSettings'

type SettingsViewTab =
  | 'general'
  | 'appearance'
  | 'models'
  | 'workspaces'
  | 'files'
  | 'shortcuts'
  | 'integrations'

const SETTINGS_NAV_ITEMS: Array<{
  id: SettingsViewTab
  label: string
  icon: LucideIcon
}> = [
  { id: 'general', label: '通用', icon: Cog },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'models', label: '模型', icon: Box },
  { id: 'workspaces', label: '工作区', icon: Users },
  { id: 'files', label: '文件与同步', icon: Cloud },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'integrations', label: 'MCP 与集成', icon: Puzzle },
]

export function SettingsView() {
  const [tab, setTab] = useState<SettingsViewTab>('general')
  const title = SETTINGS_PAGE_TITLES[tab]
  const subtitle = SETTINGS_PAGE_SUBTITLES[tab]

  return (
    <div className="flex flex-1 min-w-0 min-h-0 gap-8 bg-[var(--background)]">
      <aside className="w-[174px] shrink-0 rounded-tr-[12px] border-r border-t border-[var(--border)] bg-[var(--surface-1)] px-3 py-5 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <h1 className="mb-3 px-2.5 text-[22px] font-semibold leading-7 text-[var(--text-1)]">设置</h1>
        <nav className="space-y-1.5">
          {SETTINGS_NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const selected = tab === item.id

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] font-medium transition-colors',
                  selected
                    ? 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                    : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]'
                )}
              >
                <Icon size={16} strokeWidth={1.9} className="shrink-0" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      <ScrollArea className="flex-1 min-w-0 min-h-0 pr-8 pt-4 pb-0">
        <main className="min-w-0 py-5">
          <div className="mb-4">
            <h2 className="text-[22px] font-semibold leading-7 text-[var(--text-1)]">{title}</h2>
            <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">{subtitle}</p>
          </div>
          {tab === 'general' && <GeneralSettings />}
          {tab === 'appearance' && (
            <SettingsPlaceholder
              title="外观"
              desc="外观配置仍沿用现有主题系统，后续可以在这里承载深浅色与显示密度。"
            />
          )}
          {tab === 'models' && <AgentSettings />}
          {tab === 'workspaces' && <WorkspacesSettings />}
          {tab === 'files' && <SettingsContentShell><SkillsSettings /></SettingsContentShell>}
          {tab === 'shortcuts' && <SettingsContentShell><AutomationSettings /></SettingsContentShell>}
          {tab === 'integrations' && <McpSettings />}
        </main>
      </ScrollArea>
    </div>
  )
}

const SETTINGS_PAGE_TITLES: Record<SettingsViewTab, string> = {
  general: '通用设置',
  appearance: '外观',
  models: '模型与供应商',
  workspaces: '工作区设置',
  files: '文件与同步',
  shortcuts: '快捷键',
  integrations: 'MCP 与集成',
}

const SETTINGS_PAGE_SUBTITLES: Record<SettingsViewTab, string> = {
  general: '管理你的应用偏好、模型配置与工作区设置',
  appearance: '调整界面外观、显示密度与主题偏好',
  models: '管理默认模型、供应商连接与可用模型配置',
  workspaces: '管理多个本地工作区的基本信息、目录和默认行为',
  files: '管理文件接入、同步状态与资料上下文',
  shortcuts: '管理键盘快捷键与常用自动化操作',
  integrations: '管理 MCP 服务发现、连接状态与集成能力',
}

function SettingsContentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
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
