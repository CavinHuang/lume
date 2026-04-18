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
