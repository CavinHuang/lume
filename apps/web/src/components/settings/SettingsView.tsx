import { useState } from 'react'
import { Radio, Cpu, Puzzle, Info, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { GeneralSettings } from './GeneralSettings'
import { ChannelSettings } from './ChannelSettings'
import { AgentSettings } from './AgentSettings'
import { McpSettings } from './McpSettings'
import { AboutSettings } from './AboutSettings'
import { SETTINGS_NAV_ITEMS, type SettingsTab } from './general-settings-state'

const NAV_ICON_MAP: Record<SettingsTab, React.ReactNode> = {
  general: <SlidersHorizontal size={15} />,
  channels: <Radio size={15} />,
  agent: <Cpu size={15} />,
  mcp: <Puzzle size={15} />,
  about: <Info size={15} />,
}

export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>('general')

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左侧导航 */}
      <div className="w-48 flex-shrink-0 border-r border-border/50 p-3 space-y-0.5">
        <p className="px-3 py-2 text-[11px] font-semibold text-foreground/40 uppercase tracking-wider">设置</p>
        {SETTINGS_NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] transition-colors',
              tab === item.id
                ? 'bg-foreground/[0.08] text-foreground font-medium'
                : 'text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground'
              )}
          >
            {NAV_ICON_MAP[item.id]}
            {item.label}
          </button>
        ))}
      </div>

      {/* 右侧内容 */}
      <ScrollArea className="flex-1 min-w-0 min-h-0">
        <div className="min-h-full">
          {tab === 'general' && <GeneralSettings />}
          {tab === 'channels' && <ChannelSettings />}
          {tab === 'agent' && <AgentSettings />}
          {tab === 'mcp' && <McpSettings />}
          {tab === 'about' && <AboutSettings />}
        </div>
      </ScrollArea>
    </div>
  )
}
