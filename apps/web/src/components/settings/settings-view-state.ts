import {
  Archive,
  BookOpen,
  Box,
  Cog,
  Database,
  Globe,
  PlugZap,
  HardDrive,
  Bot,
  Keyboard,
  MessageCircle,
  Monitor,
  Palette,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  ScrollText,
  Users,
  type LucideIcon,
} from 'lucide-react'

export type SettingsViewTab =
  | 'general'
  | 'appearance'
  | 'models'
  | 'agents'
  | 'skills'
  | 'workspaces'
  | 'memory'
  | 'reading'
  | 'permissions'
  | 'desktop-assistant'
  | 'shortcuts'
  | 'integrations'
  | 'im-integrations'
  | 'web-search'
  | 'updates'
  | 'data'
  | 'logs'
  | 'archive'
  | 'browser'
  | 'link-runtime'

export const SETTINGS_NAV_ITEMS: Array<{
  id: SettingsViewTab
  label: string
  icon: LucideIcon
}> = [
  { id: 'general', label: '通用', icon: Cog },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'models', label: '模型', icon: Box },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'skills', label: '技能管理', icon: Puzzle },
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'link-runtime', label: 'Link 运行时', icon: PlugZap },
  { id: 'workspaces', label: '工作区', icon: Users },
  { id: 'memory', label: '记忆设置', icon: Database },
  { id: 'reading', label: '读书', icon: BookOpen },
  { id: 'permissions', label: '权限管理', icon: ShieldCheck },
  { id: 'desktop-assistant', label: '桌面助手', icon: Monitor },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'integrations', label: 'MCP', icon: Puzzle },
  { id: 'im-integrations', label: 'IM 集成', icon: MessageCircle },
  { id: 'web-search', label: '网络搜索', icon: Search },
  { id: 'data', label: '数据管理', icon: HardDrive },
  { id: 'logs', label: '应用日志', icon: ScrollText },
  { id: 'archive', label: '归档', icon: Archive },
  { id: 'updates', label: '版本与更新', icon: RefreshCw },
]

export const SETTINGS_PAGE_TITLES: Record<SettingsViewTab, string> = {
  general: '通用设置',
  appearance: '外观',
  models: '模型与供应商',
  agents: 'Agents 团队',
  skills: '技能管理',
  workspaces: '工作区设置',
  memory: '记忆设置',
  reading: '读书',
  permissions: '权限管理',
  'desktop-assistant': '桌面助手',
  shortcuts: '快捷键',
  integrations: 'MCP',
  'im-integrations': 'IM 集成',
  'web-search': '网络搜索',
  updates: '版本与更新',
  data: '数据管理',
  logs: '应用日志',
  archive: '归档与回收站',
  browser: '浏览器',
  'link-runtime': 'OpenConnector Link',
}

export const SETTINGS_PAGE_SUBTITLES: Record<SettingsViewTab, string> = {
  general: '管理你的应用偏好、模型配置与工作区设置',
  appearance: '调整界面外观、显示密度与主题偏好',
  models: '管理默认模型、供应商连接与可用模型配置',
  agents: '管理内置角色、推荐关键词与子代理运行时身份',
  skills: '管理自定义技能、触发条件与工具权限',
  workspaces: '管理多个本地工作区的基本信息、目录和默认行为',
  memory: '管理主动记忆、后台整理、召回与迁移诊断',
  reading: '管理 Lume 的阅读节奏、微信读书连接和读书模型',
  permissions: '管理权限模式和工具调用规则',
  'desktop-assistant': '管理跨应用上下文、Computer Use、主动建议和本地活动记录',
  shortcuts: '管理键盘快捷键与常用操作',
  integrations: '管理 MCP 服务发现与连接状态',
  'im-integrations': '管理微信、飞书等 IM 平台链接',
  'web-search': '配置网络搜索后端、API Key 和搜索策略',
  updates: '管理 Lume 的版本检查、下载与安装体验',
  data: '查看存储用量、安全清理与全量数据导出',
  logs: '查看应用、Agent、工具调用、MCP 与 Skill 加载运行日志',
  archive: '查看已归档的会话，恢复或永久删除，管理回收站',
  browser: '管理内置浏览器、Agent 控制和外部 Chrome 能力',
  'link-runtime': '管理加密、仅本机监听的 OpenConnector 运行时',
}
