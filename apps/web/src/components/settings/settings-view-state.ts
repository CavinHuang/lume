import {
  Box,
  Cloud,
  Cog,
  Database,
  Bot,
  Keyboard,
  MessageCircle,
  Palette,
  Puzzle,
  RefreshCw,
  Users,
  type LucideIcon,
} from 'lucide-react'

export type SettingsViewTab =
  | 'general'
  | 'appearance'
  | 'models'
  | 'agents'
  | 'workspaces'
  | 'memory'
  | 'files'
  | 'shortcuts'
  | 'integrations'
  | 'im-integrations'
  | 'updates'

export const SETTINGS_NAV_ITEMS: Array<{
  id: SettingsViewTab
  label: string
  icon: LucideIcon
}> = [
  { id: 'general', label: '通用', icon: Cog },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'models', label: '模型', icon: Box },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'workspaces', label: '工作区', icon: Users },
  { id: 'memory', label: '记忆', icon: Database },
  { id: 'files', label: '文件与同步', icon: Cloud },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'integrations', label: 'MCP', icon: Puzzle },
  { id: 'im-integrations', label: 'IM 集成', icon: MessageCircle },
  { id: 'updates', label: '版本与更新', icon: RefreshCw },
]

export const SETTINGS_PAGE_TITLES: Record<SettingsViewTab, string> = {
  general: '通用设置',
  appearance: '外观',
  models: '模型与供应商',
  agents: 'Agents 团队',
  workspaces: '工作区设置',
  memory: '记忆',
  files: '文件与同步',
  shortcuts: '快捷键',
  integrations: 'MCP',
  'im-integrations': 'IM 集成',
  updates: '版本与更新',
}

export const SETTINGS_PAGE_SUBTITLES: Record<SettingsViewTab, string> = {
  general: '管理你的应用偏好、模型配置与工作区设置',
  appearance: '调整界面外观、显示密度与主题偏好',
  models: '管理默认模型、供应商连接与可用模型配置',
  agents: '管理内置角色、推荐关键词与子代理运行时身份',
  workspaces: '管理多个本地工作区的基本信息、目录和默认行为',
  memory: '查看、搜索、蒸馏和确认工作区与全局记忆',
  files: '管理文件接入、同步状态与资料上下文',
  shortcuts: '管理键盘快捷键与常用自动化操作',
  integrations: '管理 MCP 服务发现与连接状态',
  'im-integrations': '管理微信、飞书等 IM 平台链接',
  updates: '管理 Lume 的版本检查、下载与安装体验',
}
