import type { LumeConfigThinkingLevel } from '@lume/shared'

export type PermissionModeValue = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export type PermissionModeTone = 'sky' | 'emerald' | 'amber' | 'violet'

export type PermissionModeIconKey = 'shield' | 'pencil' | 'shield-off' | 'map'

export interface PermissionOption {
  value: PermissionModeValue
  label: string
  desc: string
  icon: PermissionModeIconKey
  tone: PermissionModeTone
  emphasis: string
}

export const TONE_CLASS: Record<PermissionModeTone, string> = {
  sky: 'bg-sky-500/10 text-sky-600 border-sky-500/15 dark:text-sky-400',
  emerald:
    'bg-emerald-500/10 text-emerald-600 border-emerald-500/15 dark:text-emerald-400',
  amber:
    'bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-300',
  violet:
    'bg-violet-500/10 text-violet-600 border-violet-500/15 dark:text-violet-400',
}

export interface ThinkingLevelOption {
  value: LumeConfigThinkingLevel
  label: string
  desc: string
  emphasis: string
  tone: PermissionModeTone
}

export const THINKING_LEVEL_OPTIONS: ThinkingLevelOption[] = [
  { value: 'off', label: '关闭', desc: '不使用扩展思考', emphasis: '最快', tone: 'sky' },
  { value: 'low', label: '低', desc: '~1K tokens，轻量推理', emphasis: '快速', tone: 'sky' },
  { value: 'medium', label: '中', desc: '~4K tokens，平衡推理', emphasis: '均衡', tone: 'emerald' },
  { value: 'high', label: '高', desc: '~8K tokens，深度推理', emphasis: '深度', tone: 'violet' },
  { value: 'max', label: '最大', desc: '~16K tokens，极致推理', emphasis: '最强', tone: 'amber' },
]

export const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    value: 'default',
    label: '默认',
    desc: '每次确认高风险操作',
    icon: 'shield',
    tone: 'sky',
    emphasis: '受控',
  },
  {
    value: 'acceptEdits',
    label: '允许编辑',
    desc: '自动接受文件编辑，确认其他操作',
    icon: 'pencil',
    tone: 'emerald',
    emphasis: '高效',
  },
  {
    value: 'bypassPermissions',
    label: '全部允许',
    desc: '跳过所有权限确认（谨慎使用）',
    icon: 'shield-off',
    tone: 'amber',
    emphasis: '高风险',
  },
  {
    value: 'plan',
    label: 'Plan 模式',
    desc: '先规划再执行，每步确认',
    icon: 'map',
    tone: 'violet',
    emphasis: '规划',
  },
]
