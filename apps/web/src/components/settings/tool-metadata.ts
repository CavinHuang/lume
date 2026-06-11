/**
 * 前端工具元数据定义
 *
 * 用于工具管理页面的展示，包含工具的描述、类别和风险等级。
 * 与 sidecar tool-metadata.ts 保持同步。
 */

export type ToolCategory = 'read' | 'write' | 'execute' | 'control' | 'network'

export type ToolRiskLevel = 'low' | 'medium' | 'high'

export interface FrontendToolMeta {
  /** 工具内部名称 (canonical name) */
  name: string
  /** 展示名称 */
  label: string
  /** 简短描述 */
  description: string
  /** 工具类别 */
  category: ToolCategory
  /** 风险等级 */
  riskLevel: ToolRiskLevel
}

export const TOOL_METADATA: Record<string, FrontendToolMeta> = {
  // === 核心文件 I/O ===
  bash: {
    name: 'bash',
    label: 'Bash',
    description: '执行 Shell 命令',
    category: 'execute',
    riskLevel: 'high',
  },
  read: {
    name: 'read',
    label: 'Read',
    description: '读取文件内容',
    category: 'read',
    riskLevel: 'low',
  },
  write: {
    name: 'write',
    label: 'Write',
    description: '创建或覆盖文件',
    category: 'write',
    riskLevel: 'medium',
  },
  edit: {
    name: 'edit',
    label: 'Edit',
    description: '编辑文件内容',
    category: 'write',
    riskLevel: 'medium',
  },
  find: {
    name: 'find',
    label: 'Glob',
    description: '按模式搜索文件路径',
    category: 'read',
    riskLevel: 'low',
  },
  grep: {
    name: 'grep',
    label: 'Grep',
    description: '在文件中搜索文本内容',
    category: 'read',
    riskLevel: 'low',
  },
  ls: {
    name: 'ls',
    label: 'List Dir',
    description: '列出目录内容',
    category: 'read',
    riskLevel: 'low',
  },
  notebook_edit: {
    name: 'notebook_edit',
    label: 'NotebookEdit',
    description: '编辑 Jupyter Notebook 单元格',
    category: 'write',
    riskLevel: 'medium',
  },

  // === Web ===
  web_search: {
    name: 'web_search',
    label: 'WebSearch',
    description: '网络搜索',
    category: 'network',
    riskLevel: 'low',
  },
  web_fetch: {
    name: 'web_fetch',
    label: 'WebFetch',
    description: '获取网页内容',
    category: 'network',
    riskLevel: 'low',
  },
  guanlan_search: {
    name: 'guanlan_search',
    label: 'Guanlan 搜索',
    description: 'Guanlan 中文互联网搜索',
    category: 'network',
    riskLevel: 'low',
  },
  guanlan_read: {
    name: 'guanlan_read',
    label: 'Guanlan 阅读',
    description: 'Guanlan 中文网页阅读',
    category: 'network',
    riskLevel: 'low',
  },
  guanlan_hotnews: {
    name: 'guanlan_hotnews',
    label: 'Guanlan 热榜',
    description: 'Guanlan 中文热榜',
    category: 'network',
    riskLevel: 'low',
  },
  guanlan_research: {
    name: 'guanlan_research',
    label: 'Guanlan 研究',
    description: 'Guanlan 研究证据包',
    category: 'network',
    riskLevel: 'low',
  },

  // === Agent & 多 Agent ===
  agent_spawn: {
    name: 'agent_spawn',
    label: 'Agent',
    description: '启动子 Agent 执行任务',
    category: 'execute',
    riskLevel: 'medium',
  },
  send_message: {
    name: 'send_message',
    label: 'SendMessage',
    description: '向其他会话发送消息',
    category: 'execute',
    riskLevel: 'medium',
  },
  team_create: {
    name: 'team_create',
    label: 'TeamCreate',
    description: '创建 Agent 团队',
    category: 'control',
    riskLevel: 'medium',
  },
  team_delete: {
    name: 'team_delete',
    label: 'TeamDelete',
    description: '删除 Agent 团队',
    category: 'control',
    riskLevel: 'medium',
  },

  // === 任务 ===
  task_create: {
    name: 'task_create',
    label: 'TaskCreate',
    description: '创建任务',
    category: 'control',
    riskLevel: 'low',
  },
  task_list: {
    name: 'task_list',
    label: 'TaskList',
    description: '列出任务',
    category: 'read',
    riskLevel: 'low',
  },
  task_update: {
    name: 'task_update',
    label: 'TaskUpdate',
    description: '更新任务状态',
    category: 'control',
    riskLevel: 'low',
  },
  task_get: {
    name: 'task_get',
    label: 'TaskGet',
    description: '获取任务详情',
    category: 'read',
    riskLevel: 'low',
  },
  task_stop: {
    name: 'task_stop',
    label: 'TaskStop',
    description: '停止任务',
    category: 'control',
    riskLevel: 'low',
  },
  task_output: {
    name: 'task_output',
    label: 'TaskOutput',
    description: '获取任务输出',
    category: 'read',
    riskLevel: 'low',
  },

  // === Worktree ===
  enter_worktree: {
    name: 'enter_worktree',
    label: 'EnterWorktree',
    description: '进入 Git worktree',
    category: 'execute',
    riskLevel: 'medium',
  },
  exit_worktree: {
    name: 'exit_worktree',
    label: 'ExitWorktree',
    description: '退出 Git worktree',
    category: 'execute',
    riskLevel: 'medium',
  },

  // === 用户交互 ===
  ask_user_question: {
    name: 'ask_user_question',
    label: 'AskUserQuestion',
    description: '向用户提问',
    category: 'control',
    riskLevel: 'low',
  },

  // === 工具发现 ===
  tool_search: {
    name: 'tool_search',
    label: 'ToolSearch',
    description: '搜索可用工具',
    category: 'read',
    riskLevel: 'low',
  },

  // === MCP 资源 ===
  list_mcp_resources: {
    name: 'list_mcp_resources',
    label: 'ListMcpResources',
    description: '列出 MCP 资源',
    category: 'read',
    riskLevel: 'low',
  },
  read_mcp_resource: {
    name: 'read_mcp_resource',
    label: 'ReadMcpResource',
    description: '读取 MCP 资源',
    category: 'read',
    riskLevel: 'low',
  },
  subscribe_mcp_resource: {
    name: 'subscribe_mcp_resource',
    label: 'SubscribeMcpResource',
    description: '订阅 MCP 资源更新',
    category: 'control',
    riskLevel: 'low',
  },
  unsubscribe_mcp_resource: {
    name: 'unsubscribe_mcp_resource',
    label: 'UnsubscribeMcpResource',
    description: '取消订阅 MCP 资源',
    category: 'control',
    riskLevel: 'low',
  },
  subscribe_polling: {
    name: 'subscribe_polling',
    label: 'SubscribePolling',
    description: '订阅轮询更新',
    category: 'control',
    riskLevel: 'low',
  },
  unsubscribe_polling: {
    name: 'unsubscribe_polling',
    label: 'UnsubscribePolling',
    description: '取消轮询订阅',
    category: 'control',
    riskLevel: 'low',
  },
  mcp_auth: {
    name: 'mcp_auth',
    label: 'McpAuth',
    description: 'MCP 认证',
    category: 'control',
    riskLevel: 'low',
  },

  // === LSP ===
  lsp: {
    name: 'lsp',
    label: 'LSP',
    description: 'LSP 代码智能查询',
    category: 'read',
    riskLevel: 'low',
  },

  // === 配置 ===
  config: {
    name: 'config',
    label: 'Config',
    description: '读取和修改 Lume 配置',
    category: 'control',
    riskLevel: 'high',
  },

  // === Todo ===
  todo_write: {
    name: 'todo_write',
    label: 'TodoWrite',
    description: '管理任务列表',
    category: 'control',
    riskLevel: 'low',
  },

  // === 技能 ===
  skill: {
    name: 'skill',
    label: 'Skill',
    description: '执行技能',
    category: 'control',
    riskLevel: 'low',
  },

  // === 记忆 ===
  memory_search: {
    name: 'memory.search',
    label: 'Memory Search',
    description: '搜索记忆内容',
    category: 'read',
    riskLevel: 'low',
  },
  memory_read: {
    name: 'memory.read',
    label: 'Memory Read',
    description: '读取记忆内容',
    category: 'read',
    riskLevel: 'low',
  },
  memory_remember: {
    name: 'memory.remember',
    label: 'Memory Remember',
    description: '保存结构化记忆',
    category: 'write',
    riskLevel: 'medium',
  },

  // === 定时任务 ===
  cron_set: {
    name: 'cron_set',
    label: 'Cron',
    description: '设置定时任务（创建/更新/删除/启停）',
    category: 'write',
    riskLevel: 'medium',
  },
  automation_set: {
    name: 'automation_set',
    label: 'Automation',
    description: '设置自动化任务（创建/更新/删除/启停/立即执行）',
    category: 'write',
    riskLevel: 'high',
  },

  // === IM 渠道 ===
  send_im_message: {
    name: 'send_im_message',
    label: 'Send IM',
    description: '向当前线程绑定的 IM 会话发送消息',
    category: 'execute',
    riskLevel: 'medium',
  },

  // === UI 自进化 ===
  personalize_ui: {
    name: 'personalize_ui',
    label: 'Personalize UI',
    description: '读取或更新 Lume 支持的界面状态',
    category: 'write',
    riskLevel: 'medium',
  },

  // === Office 文档 ===
  office_validate: {
    name: 'office_validate',
    label: 'Office Validate',
    description: '只读校验 Office OOXML 文档结构',
    category: 'read',
    riskLevel: 'low',
  },
  office_unpack: {
    name: 'office_unpack',
    label: 'Office Unpack',
    description: '安全解包 Office OOXML 文档到本地目录',
    category: 'write',
    riskLevel: 'medium',
  },
  office_pack: {
    name: 'office_pack',
    label: 'Office Pack',
    description: '将解包目录重新打包为 Office OOXML 文档',
    category: 'write',
    riskLevel: 'medium',
  },

  // === 阅读 ===
  lume_reading_snapshot: {
    name: 'lume_reading_snapshot',
    label: 'Reading Snapshot',
    description: '读取 Lume Reading 书架和笔记快照',
    category: 'read',
    riskLevel: 'low',
  },
  lume_add_book: {
    name: 'lume_add_book',
    label: 'Add Book',
    description: '向 Lume Reading 添加书籍',
    category: 'write',
    riskLevel: 'medium',
  },
  lume_write_reading_note: {
    name: 'lume_write_reading_note',
    label: 'Write Reading Note',
    description: '写入 Lume Reading 读书笔记',
    category: 'write',
    riskLevel: 'medium',
  },
  lume_hide_reading_note: {
    name: 'lume_hide_reading_note',
    label: 'Hide Reading Note',
    description: '隐藏 Lume Reading 读书笔记',
    category: 'write',
    riskLevel: 'medium',
  },
  lume_revise_reading_note: {
    name: 'lume_revise_reading_note',
    label: 'Revise Reading Note',
    description: '修订 Lume Reading 读书笔记',
    category: 'write',
    riskLevel: 'medium',
  },
  lume_generate_share_card: {
    name: 'lume_generate_share_card',
    label: 'Generate Share Card',
    description: '生成 Lume Reading 分享卡片本地资产',
    category: 'write',
    riskLevel: 'medium',
  },
  weread_generate_note: {
    name: 'weread_generate_note',
    label: 'Weread Generate Note',
    description: '基于微信读书内容生成 Lume Reading 本地笔记',
    category: 'write',
    riskLevel: 'medium',
  },
  weread_export_all_notes: {
    name: 'weread_export_all_notes',
    label: 'Weread Export Notes',
    description: '导出 Lume Reading 笔记本地文件',
    category: 'write',
    riskLevel: 'medium',
  },
  weread_shelf: {
    name: 'weread_shelf',
    label: 'Weread Shelf',
    description: '读取微信读书书架',
    category: 'network',
    riskLevel: 'low',
  },
  weread_notebooks: {
    name: 'weread_notebooks',
    label: 'Weread Notebooks',
    description: '读取微信读书笔记本列表',
    category: 'network',
    riskLevel: 'low',
  },
  weread_bookmarks: {
    name: 'weread_bookmarks',
    label: 'Weread Bookmarks',
    description: '读取微信读书划线',
    category: 'network',
    riskLevel: 'low',
  },
  weread_best_bookmarks: {
    name: 'weread_best_bookmarks',
    label: 'Weread Best Bookmarks',
    description: '读取微信读书热门划线',
    category: 'network',
    riskLevel: 'low',
  },
  weread_reviews: {
    name: 'weread_reviews',
    label: 'Weread Reviews',
    description: '读取微信读书笔记',
    category: 'network',
    riskLevel: 'low',
  },
  weread_public_reviews: {
    name: 'weread_public_reviews',
    label: 'Weread Public Reviews',
    description: '读取微信读书公开笔记',
    category: 'network',
    riskLevel: 'low',
  },
  weread_readdata: {
    name: 'weread_readdata',
    label: 'Weread Read Data',
    description: '读取微信读书阅读数据',
    category: 'network',
    riskLevel: 'low',
  },
  weread_search: {
    name: 'weread_search',
    label: 'Weread Search',
    description: '搜索微信读书内容',
    category: 'network',
    riskLevel: 'low',
  },
}

/**
 * 根据工具名称获取元数据
 */
export function getToolMeta(name: string): FrontendToolMeta | undefined {
  return TOOL_METADATA[name]
}

/**
 * 获取所有已注册的工具名称
 */
export function getAllToolNames(): string[] {
  return Object.keys(TOOL_METADATA)
}

/**
 * 根据类别筛选工具
 */
export function getToolsByCategory(category: ToolCategory): FrontendToolMeta[] {
  return Object.values(TOOL_METADATA).filter((tool) => tool.category === category)
}

/**
 * 风险等级对应的中文标签和颜色
 */
export const RISK_LEVEL_CONFIG: Record<
  ToolRiskLevel,
  { label: string; className: string }
> = {
  low: { label: '低', className: 'text-[#4c7a41] bg-[#f7fbf5]' },
  medium: { label: '中', className: 'text-[#b87a2a] bg-[#fef9f0]' },
  high: { label: '高', className: 'text-[#ba3636] bg-[#fff8f8]' },
}

/**
 * 类别对应的中文标签和图标
 */
export const CATEGORY_CONFIG: Record<
  ToolCategory,
  { label: string; icon: string }
> = {
  read: { label: '读取', icon: '📖' },
  write: { label: '写入', icon: '✏️' },
  execute: { label: '执行', icon: '⚡' },
  control: { label: '控制', icon: '🎮' },
  network: { label: '网络', icon: '🌐' },
}
