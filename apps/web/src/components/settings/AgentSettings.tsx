/**
 * AgentSettings - Agent 设置页
 *
 * 包含：
 * 1. Agent 高级设置（思考等级、最大轮次）
 * 2. 权限模式配置
 */

import * as React from 'react'
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Map,
  PencilLine,
  Shield,
  ShieldOff,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { DefaultModelStrategyPanel } from './DefaultModelStrategyPanel'
import { SubagentDefaultModelPanel } from './SubagentDefaultModelPanel'
import {
  PERMISSION_OPTIONS,
  TONE_CLASS,
  type PermissionModeIconKey,
} from './agent-settings-state'
import { ThinkingLevelPicker } from '@/components/agent/ThinkingLevelPicker'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'
import { sidecarCall } from '@/lib/desktop-api'
import type { LumeEffectiveConfig, LumeConfigThinkingLevel } from '@lume/shared'

const PERMISSION_ICON_MAP: Record<PermissionModeIconKey, LucideIcon> = {
  shield: Shield,
  pencil: PencilLine,
  'shield-off': ShieldOff,
  map: Map,
}

export function AgentSettings() {
  const [thinkingLevel, setThinkingLevel] = React.useState<LumeConfigThinkingLevel>('off')
  const [permissionMode, setPermissionMode] = React.useState('default')
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    getEffectiveLumeConfig()
      .then((config: LumeEffectiveConfig) => {
        if (config.agent?.thinkingLevel) {
          setThinkingLevel(config.agent.thinkingLevel)
        }
        if (config.agent?.permissionMode) {
          setPermissionMode(config.agent.permissionMode)
        }
      })
      .catch((err) => console.error('[AgentSettings] load FAILED:', err))
      .finally(() => setLoading(false))
  }, [])

  const updateConfig = (path: string, value: unknown) => {
    sidecarCall('lume-config:update-section', {
      source: 'user',
      path,
      value,
      summary: `set ${path}`,
    }).catch((err) => console.error('[AgentSettings] save FAILED:', path, err))
  }

  const handleThinkingLevelChange = (value: LumeConfigThinkingLevel) => {
    setThinkingLevel(value)
    updateConfig('agent.thinkingLevel', value)
  }

  const handlePermissionChange = (value: string) => {
    setPermissionMode(value)
    updateConfig('agent.permissionMode', value === 'default' ? null : value)
  }

  if (loading) {
    return <div className="p-8 text-[13px] text-muted-foreground">加载中...</div>
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-[15px] font-semibold">Agent 设置</h2>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          配置 Agent 运行行为和默认模型策略
        </p>
      </div>

      <DefaultModelStrategyPanel />

      <SubagentDefaultModelPanel />

      <Separator />

      <SettingsBlock
        title="权限模式"
        desc="控制 Agent 执行工具时的权限确认策略"
      >
        <div className="space-y-2">
          {PERMISSION_OPTIONS.map((opt) => (
            <PermissionModeCard
              key={opt.value}
              option={opt}
              selected={permissionMode === opt.value}
              onSelect={() => handlePermissionChange(opt.value)}
            />
          ))}
        </div>
      </SettingsBlock>

      <Separator />

      <div>
        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="flex items-center gap-2 text-[13px] font-medium text-foreground/80 hover:text-foreground transition-colors"
        >
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Cpu size={14} />
          高级设置
        </button>

        {advancedOpen && (
          <div className="mt-4 space-y-5 pl-1">
            <SettingsBlock
              title="思考等级"
              desc="控制 Agent 的扩展思考深度，等级越高推理越深入"
            >
              <ThinkingLevelPicker
                value={thinkingLevel}
                onChange={handleThinkingLevelChange}
                inline
              />
            </SettingsBlock>
          </div>
        )}
      </div>
    </div>
  )
}

function PermissionModeCard({
  option,
  selected,
  onSelect,
}: {
  option: (typeof PERMISSION_OPTIONS)[number]
  selected: boolean
  onSelect: () => void
}) {
  const Icon = PERMISSION_ICON_MAP[option.icon]

  return (
    <label
      className={cn(
        'group flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-all border',
        selected
          ? 'border-primary/30 bg-primary/5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
          : 'border-transparent hover:bg-muted/30',
      )}
    >
      <input
        type="radio"
        name="permission"
        value={option.value}
        checked={selected}
        onChange={onSelect}
        className="accent-primary"
      />
      <Icon
        size={16}
        className={cn('shrink-0 transition-colors', TONE_CLASS[option.tone])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className={cn('text-[13px] font-medium', selected && 'text-foreground')}>
            {option.label}
          </div>
          <Badge
            variant="outline"
            className={cn('h-5 rounded-full border px-2 text-[10px] font-medium', TONE_CLASS[option.tone])}
          >
            {option.emphasis}
          </Badge>
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{option.desc}</div>
      </div>
    </label>
  )
}

function SettingsBlock({
  title,
  desc,
  children,
}: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div>
        <Label className="text-[13px] font-medium">{title}</Label>
        {desc && <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>}
      </div>
      {children}
    </div>
  )
}
