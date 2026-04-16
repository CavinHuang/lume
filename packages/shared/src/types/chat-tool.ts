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
  category: "builtin" | "custom"
  /** 参数定义（自定义工具可选） */
  params?: ChatToolParam[]
  /** 执行器类型（自定义工具可选） */
  executorType?: "builtin" | "http"
  /** HTTP 执行器配置（executorType=http 时使用） */
  httpConfig?: ChatToolHttpConfig
  /** 该工具启用时附加到 system prompt 的提示（可选） */
  systemPromptAppend?: string
}

export interface ChatToolParam {
  /** 参数名 */
  name: string
  /** 参数类型 */
  type: "string" | "number" | "boolean"
  /** 参数说明 */
  description: string
  /** 是否必填 */
  required?: boolean
  /** 可选值枚举 */
  enum?: string[]
}

export interface ChatToolHttpConfig {
  /** URL 模板，支持 {{param}} 占位符 */
  urlTemplate: string
  /** HTTP 方法 */
  method: "GET" | "POST"
  /** 请求头 */
  headers?: Record<string, string>
  /** 请求体模板（JSON 字符串） */
  bodyTemplate?: string
  /** 结果提取路径（可选） */
  resultPath?: string
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
  /** 自定义工具定义 */
  customTools: ChatToolMeta[]
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

export interface ChatToolChangedEvent {
  /** 变更工具 ID */
  toolId: string
  /** 变更类型 */
  changeType: "state" | "credentials" | "create" | "delete" | "external"
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
  TEST_TOOL: "chat-tool:test",
  /** 创建自定义工具 */
  CREATE_CUSTOM_TOOL: "chat-tool:create-custom",
  /** 删除自定义工具 */
  DELETE_CUSTOM_TOOL: "chat-tool:delete-custom",
  /** 工具配置变更通知 */
  CUSTOM_TOOL_CHANGED: "chat-tool:custom-tool-changed"
} as const
