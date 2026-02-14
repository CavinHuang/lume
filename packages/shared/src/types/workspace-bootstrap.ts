/**
 * Workspace Bootstrap Types
 *
 * 复用自 OpenClaw 的 workspace bootstrap 设计
 * 参考: openclaw/src/agents/workspace.ts
 */

// ===== Bootstrap 文件类型 =====

/**
 * Bootstrap 文件类型
 *
 * 决定在新建工作区时创建哪些文件
 */
export type BootstrapFileType =
  | 'SOUL'       // 智能体人格定义
  | 'USER'       // 用户信息
  | 'IDENTITY'   // 身份标识
  | 'AGENTS'     // 操作指令
  | 'TOOLS'      // 工具说明
  | 'HEARTBEAT'  // 心跳任务
  | 'MEMORY'     // 长期记忆
  | 'BOOTSTRAP'  // 初始化指南（一次性）

/**
 * Bootstrap 文件元数据
 */
export interface BootstrapFileMeta {
  /** 文件类型 */
  type: BootstrapFileType
  /** 文件名 */
  filename: string
  /** 开发模式文件名（可选） */
  devFilename?: string
  /** 是否在所有会话类型中加载 */
  loadInAllSessions: boolean
  /** 仅在以下会话类型中加载（空表示所有） */
  sessionTypes?: ('main' | 'subagent' | 'group' | 'channel')[]
  /** 是否在首次运行后删除（如 BOOTSTRAP.md） */
  deleteAfterFirstRun?: boolean
}

/**
 * 默认 Bootstrap 文件配置
 */
export const BOOTSTRAP_FILES: BootstrapFileMeta[] = [
  {
    type: 'SOUL',
    filename: 'SOUL.md',
    devFilename: 'SOUL.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'USER',
    filename: 'USER.md',
    devFilename: 'USER.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'IDENTITY',
    filename: 'IDENTITY.md',
    devFilename: 'IDENTITY.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'AGENTS',
    filename: 'AGENTS.md',
    devFilename: 'AGENTS.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'TOOLS',
    filename: 'TOOLS.md',
    devFilename: 'TOOLS.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'HEARTBEAT',
    filename: 'HEARTBEAT.md',
    loadInAllSessions: true,
  },
  {
    type: 'MEMORY',
    filename: 'MEMORY.md',
    loadInAllSessions: false,
    sessionTypes: ['main'],
  },
  {
    type: 'BOOTSTRAP',
    filename: 'BOOTSTRAP.md',
    loadInAllSessions: false,
    sessionTypes: ['main'],
    deleteAfterFirstRun: true,
  },
]

// ===== 会话类型 =====

/**
 * 会话类型
 *
 * 决定加载哪些 Bootstrap 文件
 * - main: 主会话，直接与用户对话
 * - subagent: 子智能体会话
 * - group: 群聊会话
 * - channel: 频道会话
 */
export type SessionType = 'main' | 'subagent' | 'group' | 'channel'

// ===== Bootstrap 配置 =====

/**
 * 工作区 Bootstrap 配置
 */
export interface WorkspaceBootstrapConfig {
  /** 要创建的文件类型列表 */
  files: BootstrapFileType[]
  /** 会话类型 */
  sessionType: SessionType
  /** 是否使用开发模式模板 */
  devMode?: boolean
  /** 自定义模板目录（默认使用内置模板） */
  templateDir?: string
}

/**
 * Bootstrap 结果
 */
export interface BootstrapResult {
  /** 成功创建的文件列表 */
  created: string[]
  /** 已存在跳过的文件列表 */
  skipped: string[]
  /** 创建失败的文件及错误信息 */
  failed: Array<{ file: string; error: string }>
}

// ===== 系统提示词构建 =====

/**
 * 系统提示词组件
 *
 * 用于构建最终的系统提示词
 */
export interface SystemPromptComponents {
  /** 人格定义（SOUL.md） */
  soul?: string
  /** 用户信息（USER.md） */
  user?: string
  /** 身份标识（IDENTITY.md） */
  identity?: string
  /** 操作指令（AGENTS.md） */
  agents?: string
  /** 工具说明（TOOLS.md） */
  tools?: string
  /** 心跳任务（HEARTBEAT.md） */
  heartbeat?: string
  /** 长期记忆（MEMORY.md） */
  memory?: string
  /** 记忆文件（memory/YYYY-MM-DD.md） */
  dailyMemory?: string
}

/**
 * 系统提示词构建选项
 */
export interface SystemPromptBuildOptions {
  /** 会话类型 */
  sessionType: SessionType
  /** 是否包含记忆文件 */
  includeMemory?: boolean
  /** 是否包含每日记忆 */
  includeDailyMemory?: boolean
  /** 每日记忆天数范围（默认今天+昨天） */
  dailyMemoryDays?: number
}
