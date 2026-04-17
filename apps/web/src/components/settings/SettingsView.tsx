import { useState } from 'react'
import { Radio, Cpu, Puzzle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ChannelSettings } from './ChannelSettings'
import { AgentSettings } from './AgentSettings'
import { McpSettings } from './McpSettings'
import { AboutSettings } from './AboutSettings'

type SettingsTab = 'channels' | 'agent' | 'mcp' | 'about'

const NAV: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'channels', label: '供应商配置', icon: <Radio size={15} /> },
  { id: 'agent', label: 'Agent', icon: <Cpu size={15} /> },
  { id: 'mcp', label: 'MCP', icon: <Puzzle size={15} /> },
  { id: 'about', label: '关于', icon: <Info size={15} /> },
]

export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>('channels')

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左侧导航 */}
      <div className="w-48 flex-shrink-0 border-r border-border/50 p-3 space-y-0.5">
        <p className="px-3 py-2 text-[11px] font-semibold text-foreground/40 uppercase tracking-wider">设置</p>
        {NAV.map((item) => (
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
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {/* 右侧内容 */}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        {tab === 'channels' && <ChannelSettings />}
        {tab === 'agent' && <AgentSettings />}
        {tab === 'mcp' && <McpSettings />}
        {tab === 'about' && <AboutSettings />}
      </div>
    </div>
  )
}
