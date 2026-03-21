/**
 * Chat Tool 模块共享类型
 *
 * 用于 Chat 模式工具开关与凭据管理。
 */

export interface ChatToolMeta {
  /** 工具唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 工具描述 */
  description: string
  /** 工具图标（lucide 名称，可选） */
  icon?: string
  /** 工具类别 */
  category: "builtin"
}

export interface ChatToolState {
  /** 是否启用 */
  enabled: boolean
}

export interface ChatToolFileConfig {
  /** 配置版本 */
  version: number
  /** 各工具开关状态 */
  toolStates: Record<string, ChatToolState>
  /** 工具凭据（按 toolId 分组） */
  toolCredentials: Record<string, Record<string, string>>
}

export interface ChatToolInfo {
  /** 工具元数据 */
  meta: ChatToolMeta
  /** 当前开关状态 */
  enabled: boolean
  /** 当前是否可用（凭据/环境满足） */
  available: boolean
}

export interface ChatToolTestResult {
  /** 测试是否成功 */
  success: boolean
  /** 结果说明 */
  message: string
}

export const CHAT_TOOL_IPC_CHANNELS = {
  /** 获取所有工具信息 */
  GET_ALL_TOOLS: "chat-tool:get-all-tools",
  /** 获取单个工具凭据 */
  GET_TOOL_CREDENTIALS: "chat-tool:get-credentials",
  /** 更新单个工具开关状态 */
  UPDATE_TOOL_STATE: "chat-tool:update-state",
  /** 更新单个工具凭据 */
  UPDATE_TOOL_CREDENTIALS: "chat-tool:update-credentials",
  /** 测试工具连接/可用性 */
  TEST_TOOL: "chat-tool:test"
} as const
