/**
 * AgentSettings - Agent 设置页
 *
 * 包含：
 * 1. Agent 高级设置（思考模式、推理深度、预算限制、最大轮次）
 * 2. 工具策略配置
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
import { sidecarCall } from '@/lib/desktop-api'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { DefaultModelStrategyPanel } from './DefaultModelStrategyPanel'
import { SubagentDefaultModelPanel } from './SubagentDefaultModelPanel'
import { PERMISSION_OPTIONS, type PermissionModeIconKey, type PermissionModeTone } from './agent-settings-state'

/** 思考模式选项 */
const THINKING_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'adaptive', label: '自适应' },
  { value: 'disabled', label: '关闭' },
]

/** 推理深度选项 */
const EFFORT_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最大' },
]

const PERMISSION_ICON_MAP: Record<PermissionModeIconKey, LucideIcon> = {
  shield: Shield,
  pencil: PencilLine,
  'shield-off': ShieldOff,
  map: Map,
}

const PERMISSION_TONE_CLASS: Record<PermissionModeTone, string> = {
  sky: 'bg-sky-500/10 text-sky-600 border-sky-500/15 dark:text-sky-400',
  emerald: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/15 dark:text-emerald-400',
  amber: 'bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-300',
  violet: 'bg-violet-500/10 text-violet-600 border-violet-500/15 dark:text-violet-400',
}

export function AgentSettings() {
  const [thinking, setThinking] = React.useState('default')
  const [effort, setEffort] = React.useState('default')
  const [budgetStr, setBudgetStr] = React.useState('')
  const [turnsStr, setTurnsStr] = React.useState('')
  const [permissionMode, setPermissionMode] = React.useState('default')
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(true)

  // 加载当前配置
  React.useEffect(() => {
    sidecarCall<Record<string, unknown>>('system:get-config', {})
      .then((config) => {
        const agent = config?.agent as Record<string, unknown> | undefined
        if (agent) {
          if (agent.thinking) setThinking(String(agent.thinking))
          if (agent.effort) setEffort(String(agent.effort))
          if (agent.maxBudgetUsd != null) setBudgetStr(String(agent.maxBudgetUsd))
          if (agent.maxTurns != null) setTurnsStr(String(agent.maxTurns))
        }
        const permissions = config?.permissions as Record<string, unknown> | undefined
        if (permissions?.mode) setPermissionMode(String(permissions.mode))
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const updateConfig = (path: string, value: unknown) => {
    sidecarCall('system:update-config', { path, value }).catch(console.error)
  }

  const handleThinkingChange = (value: string | null) => {
    if (!value) return
    setThinking(value)
    updateConfig('agent.thinking', value === 'default' ? null : value)
  }

  const handleEffortChange = (value: string | null) => {
    if (!value) return
    setEffort(value)
    updateConfig('agent.effort', value === 'default' ? null : value)
  }

  const handleBudgetBlur = () => {
    const num = parseFloat(budgetStr)
    const value = !isNaN(num) && num > 0 ? num : null
    updateConfig('agent.maxBudgetUsd', value)
  }

  const handleTurnsBlur = () => {
    const num = parseInt(turnsStr, 10)
    const value = !isNaN(num) && num > 0 ? num : null
    updateConfig('agent.maxTurns', value)
  }

  const handlePermissionChange = (value: string) => {
    setPermissionMode(value)
    updateConfig('permissions.mode', value === 'default' ? null : value)
  }

  if (loading) {
    return (
      <div className="p-8 text-[13px] text-muted-foreground">加载中...</div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-[15px] font-semibold">Agent 设置</h2>
        <p className="text-[12px] text-muted-foreground mt-0.5">配置 Agent 运行行为和默认模型策略</p>
      </div>

      <DefaultModelStrategyPanel />

      <SubagentDefaultModelPanel />

      <Separator />

      {/* 权限模式 */}
      <SettingsBlock title="权限模式" desc="控制 Agent 执行工具时的权限确认策略">
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

      {/* 高级设置 */}
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
            <SettingsBlock title="思考模式" desc="自适应模式下 Agent 会根据任务复杂度自动决定是否启用深度思考">
              <Select value={thinking} onValueChange={handleThinkingChange}>
                <SelectTrigger className="w-40 h-8 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsBlock>

            <SettingsBlock title="推理深度" desc="控制 Agent 在每次回复中投入的推理计算量">
              <Select value={effort} onValueChange={handleEffortChange}>
                <SelectTrigger className="w-40 h-8 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EFFORT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsBlock>

            <SettingsBlock title="预算限制（美元/次）" desc="单次 Agent 会话的最大花费，留空则不限制">
              <Input
                type="number"
                value={budgetStr}
                onChange={(e) => setBudgetStr(e.target.value)}
                onBlur={handleBudgetBlur}
                placeholder="例如: 1.0"
                className="w-40 h-8 text-[13px]"
              />
            </SettingsBlock>

            <SettingsBlock title="最大轮次" desc="单次 Agent 会话的最大交互轮次，留空则使用默认值">
              <Input
                type="number"
                value={turnsStr}
                onChange={(e) => setTurnsStr(e.target.value)}
                onBlur={handleTurnsBlur}
                placeholder="例如: 30"
                className="w-40 h-8 text-[13px]"
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
          : 'border-transparent hover:bg-muted/30'
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
        className={cn(
          'shrink-0 transition-colors',
          PERMISSION_TONE_CLASS[option.tone]
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className={cn('text-[13px] font-medium', selected && 'text-foreground')}>
            {option.label}
          </div>
          <Badge
            variant="outline"
            className={cn(
              'h-5 rounded-full border px-2 text-[10px] font-medium',
              PERMISSION_TONE_CLASS[option.tone]
            )}
          >
            {option.emphasis}
          </Badge>
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{option.desc}</div>
      </div>
    </label>
  )
}

function SettingsBlock({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
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
