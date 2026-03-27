/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\packages\shared\src\types\agent.ts
 * Adaptation:
 * - Kept as-is for MIG-002 contract parity.
 */

/**
 * Agent 相关类型定义
 *
 * 包含 Agent SDK 集成所需的事件类型、会话管理、消息持久化和 IPC 通道常量。
 */

// ===== Agent 工作区 =====

/** Agent 工作区 */
export interface AgentWorkspace {
  /** 工作区唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** URL-safe 目录名（创建后不可变） */
  slug: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

// ===== Agent 事件类型 =====

/** Agent 事件 Usage 信息 */
export interface AgentEventUsage {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  totalTokens?: number
  costUsd?: number
  contextWindow?: number
}

/**
 * Agent 事件类型
 *
 * 从 SDK 消息转换而来的扁平事件流，用于驱动 UI 渲染。
 */
export type AgentEvent =
  // 文本流式输出
  | { type: 'text_delta'; text: string; turnId?: string; parentToolUseId?: string }
  | { type: 'text_complete'; text: string; isIntermediate: boolean; turnId?: string; parentToolUseId?: string }
  | { type: 'reasoning_delta'; text: string; turnId?: string; parentToolUseId?: string }
  | { type: 'reasoning_complete'; text: string; isIntermediate: boolean; turnId?: string; parentToolUseId?: string }
  // 工具执行
  | { type: 'tool_start'; toolName: string; toolUseId: string; input: Record<string, unknown>; intent?: string; displayName?: string; turnId?: string; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; toolName?: string; result: string; isError: boolean; input?: Record<string, unknown>; turnId?: string; parentToolUseId?: string }
  // 后台任务
  | { type: 'task_backgrounded'; toolUseId: string; taskId: string; intent?: string; turnId?: string }
  | { type: 'task_progress'; toolUseId: string; elapsedSeconds: number; turnId?: string; taskId?: string; description?: string; lastToolName?: string; usage?: { totalTokens?: number; toolUses?: number; durationMs?: number } }
  | { type: 'task_started'; taskId: string; toolUseId?: string; description: string; agentName?: string; turnId?: string }
  | { type: 'task_notification'; taskId: string; toolUseId?: string; status: 'completed' | 'failed' | 'stopped'; summary: string; usage?: { totalTokens?: number; toolUses?: number; durationMs?: number }; turnId?: string }
  | { type: 'shell_backgrounded'; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'shell_killed'; shellId: string; turnId?: string }
  // 控制流
  | { type: 'complete'; stopReason?: string; usage?: AgentEventUsage }
  | { type: 'error'; message: string }
  // Usage 更新
  | { type: 'usage_update'; usage: AgentEventUsage }
  // 上下文压缩
  | { type: 'compacting' }
  | { type: 'compact_complete' }

export type AgentRuntimePhase =
  | 'idle'
  | 'streaming'
  | 'awaiting_permission'
  | 'awaiting_user_answer'
  | 'compacting'
  | 'completed'
  | 'errored'

export interface AgentRuntimeStatus {
  sessionId: string
  phase: AgentRuntimePhase
  interactiveKind?: 'tool_permission' | 'ask_user_question'
  requestId?: string
  toolUseId?: string
  toolName?: string
  originSessionId?: string
  subagentRunId?: string
  error?: string
  updatedAt: number
}

// ===== Agent 会话管理 =====

/**
 * Agent 会话轻量索引项
 *
 * 存储在 ~/.proma/agent-sessions.json 中，
 * 类似 ConversationMeta，独立存储。
 */
export interface AgentSessionMeta {
  /** 会话唯一标识 */
  id: string
  /** 会话标题 */
  title: string
  /** 使用的渠道 ID */
  channelId?: string
  /** 最近一次运行使用的模型 ID */
  modelId?: string
  /** SDK 内部会话 ID（用于 resume 衔接上下文） */
  sdkSessionId?: string
  /** Pi Agent 会话 ID（用于显式恢复） */
  piSessionId?: string
  /** 所属工作区 ID */
  workspaceId?: string
  /** 父会话 ID（子任务会话归属） */
  parentSessionId?: string
  /** 是否置顶 */
  pinned?: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/**
 * Agent 持久化消息
 *
 * 存储在 ~/.proma/agent-sessions/{id}.jsonl 中。
 */
export interface AgentMessage {
  /** 消息唯一标识 */
  id: string
  /** 角色 */
  role: 'user' | 'assistant' | 'tool' | 'status'
  /** 消息内容 */
  content: string
  /** 模型思考内容 */
  reasoning?: string
  /** 创建时间戳 */
  createdAt: number
  /** 使用的模型 ID（assistant 消息） */
  model?: string
  /** 消息扩展元数据（用于 UI/流程标记） */
  metadata?: Record<string, unknown>
  /** 工具活动数据（agent 事件列表，用于回放工具调用） */
  events?: AgentEvent[]
  /** 同一逻辑消息链的版本组 ID */
  versionGroupId?: string
  /** 当前消息在版本组中的 1-based 版本序号 */
  versionIndex?: number
  /** 当前版本组总版本数 */
  versionCount?: number
  /** 当前版本替代的上一条消息 ID */
  supersedesMessageId?: string
  /** 当前版本被哪条更新版本替代 */
  supersededByMessageId?: string
  /** 当前版本是否为该组最新可见版本 */
  isLatestVersion?: boolean
}

/**
 * Agent 消息分页加载结果
 *
 * 用于分页加载：首次仅加载尾部 N 条消息，减少传输开销。
 */
export interface AgentRecentMessagesResult {
  /** 本次返回的消息列表（按时间正序） */
  messages: AgentMessage[]
  /** 会话中的总消息数 */
  total: number
  /** 是否还有更早的历史消息 */
  hasMore: boolean
}

// ===== Agent 标题生成输入 =====

/** Agent 标题生成输入 */
export interface AgentGenerateTitleInput {
  /** 标题来源文本（优先使用 Agent 总结） */
  sourceText?: string
  /** 兼容旧字段：用户消息 */
  userMessage?: string
  /** 渠道 ID（用于获取 API Key） */
  channelId: string
  /** 模型 ID */
  modelId: string
}

// ===== MCP 服务器配置 =====

/** MCP 传输类型 */
export type McpTransportType = 'stdio' | 'http' | 'sse'

/** MCP 服务器条目 */
export interface McpServerEntry {
  type: McpTransportType
  /** stdio: 可执行命令 */
  command?: string
  /** stdio: 命令参数 */
  args?: string[]
  /** stdio: 环境变量 */
  env?: Record<string, string>
  /** http/sse: 服务端 URL */
  url?: string
  /** http/sse: 请求头 */
  headers?: Record<string, string>
  /** 是否启用 */
  enabled: boolean
}

/** 工作区 MCP 配置文件 */
export interface WorkspaceMcpConfig {
  servers: Record<string, McpServerEntry>
}

// ===== Skill 元数据 =====

/** 工作区 Skill 元数据 */
export interface SkillMeta {
  slug: string
  name: string
  description?: string
  icon?: string
  version?: string
}

/** 工作区能力摘要（MCP + Skill 计数） */
export interface WorkspaceCapabilities {
  mcpServers: Array<{ name: string; enabled: boolean; type: McpTransportType }>
  skills: SkillMeta[]
}

// ===== Agent Tool Policy =====

export interface AgentToolPolicy {
  allow?: string[]
  deny?: string[]
}

export interface AgentRuntimeToolPolicyConfig {
  version?: number
  tools?: {
    allow?: string[]
    deny?: string[]
    byProvider?: Record<string, AgentToolPolicy>
    bySessionType?: Record<string, AgentToolPolicy>
    byChatType?: Record<string, AgentToolPolicy>
    subagent?: AgentToolPolicy
  }
}

// ===== Subagent Runs =====

export type SubagentRunStatus =
  | 'accepted'
  | 'running'
  | 'completed'
  | 'errored'
  | 'aborted'
  | 'timed_out'
  | 'canceled'

export interface SubagentRunOutcome {
  output?: string
  error?: string
  errorCode?: string
  usageEvents?: number
}

export interface SubagentRunRecord {
  runId: string
  parentSessionId: string
  parentRunId?: string
  rootSessionId: string
  depth: number
  childSessionId: string
  deliverySessionId?: string
  threadRequested?: boolean
  threadBound?: boolean
  label?: string
  task: string
  status: SubagentRunStatus
  cleanup: 'keep' | 'delete'
  parentToolUseId?: string
  requestedAgentId?: string
  resolvedAgentId?: string
  channelId?: string
  modelId?: string
  announceStatus?: 'pending' | 'delivered' | 'failed'
  announceAttempts?: number
  announceLastError?: string
  announceDeliveredAt?: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  outcome?: SubagentRunOutcome
}

export interface SubagentControlCommand {
  type: 'list' | 'kill' | 'send' | 'steer'
  runId?: string
  payload?: Record<string, unknown>
}

export interface AgentListSubagentRunsInput {
  ownerSessionId?: string
  runId?: string
  status?: SubagentRunStatus
  limit?: number
}

export interface AgentListSubagentRunsResult {
  count: number
  runs: SubagentRunRecord[]
  statusSummary: Record<SubagentRunStatus, number>
}

export type AgentProxyMode = 'off' | 'system' | 'custom'

export interface AgentProxySettings {
  version: 1
  enabled: boolean
  mode: AgentProxyMode
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
}

export interface AgentProxyStatus {
  settings: AgentProxySettings
  systemProxy: {
    httpProxy?: string
    httpsProxy?: string
    noProxy?: string
  }
}

// ===== 全局发现（Claude）=====

export type GlobalDiscoveryProvider = 'claude'

export interface GlobalDiscoveryWarning {
  code: string
  message: string
  details?: string
}

export interface GlobalMcpServerMeta {
  id: string
  provider: GlobalDiscoveryProvider
  name: string
  type: McpTransportType
  enabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  sourcePath: string
}

export interface GlobalPluginMarketplaceMeta {
  id: string
  provider: GlobalDiscoveryProvider
  sourceType: 'github' | 'directory' | 'unknown'
  sourceRef: string
  installLocation: string
  lastUpdated?: string
  autoUpdate?: boolean
}

export interface GlobalMarketplacePluginMeta {
  name: string
  description?: string
  version?: string
  source?: string
  homepage?: string
  authorName?: string
}

export interface GlobalPluginMeta {
  id: string
  provider: GlobalDiscoveryProvider
  pluginName: string
  marketplaceId: string
  installCount: number
  scopes: string[]
  versions: string[]
  projectPaths: string[]
  lastUpdated?: string
}

export interface GlobalSkillMeta {
  id: string
  provider: GlobalDiscoveryProvider
  slug: string
  name: string
  description?: string
  icon?: string
  sourcePath: string
}

export interface GlobalDiscoverySnapshot {
  version: number
  scannedAt: number
  providers: GlobalDiscoveryProvider[]
  mcpServers: GlobalMcpServerMeta[]
  pluginMarketplaces: GlobalPluginMarketplaceMeta[]
  plugins: GlobalPluginMeta[]
  skills: GlobalSkillMeta[]
  warnings: GlobalDiscoveryWarning[]
}

export interface GlobalPluginMarketplaceDetail {
  marketplace: GlobalPluginMarketplaceMeta
  plugins: GlobalMarketplacePluginMeta[]
  installedPlugins: GlobalPluginMeta[]
  warnings: GlobalDiscoveryWarning[]
}

export interface InstallGlobalPluginInput {
  marketplaceId: string
  pluginName: string
  scope?: 'user' | 'project' | 'local'
}

export interface InstallGlobalPluginResult {
  ok: true
  installed: boolean
  message: string
}

export interface ImportGlobalMcpToWorkspaceInput {
  workspaceSlug: string
  mcpId: string
  overwrite?: boolean
}

export interface ImportGlobalSkillToWorkspaceInput {
  workspaceSlug: string
  skillId: string
  overwrite?: boolean
}

export interface GlobalImportResult {
  ok: true
  imported: boolean
  reason?: string
}

// ===== Agent 发送输入 =====

/**
 * Agent 发送消息的输入参数
 */
export interface AgentSendInput {
  /** 会话 ID */
  sessionId: string
  /** 用户消息内容 */
  userMessage: string
  /** 渠道 ID（用于解析 provider/baseUrl/api key） */
  channelId?: string
  /** 模型 ID */
  modelId?: string
  /** 工作区 ID（用于确定 cwd） */
  workspaceId?: string
  /** 会话类型（用于记忆 citations auto 行为） */
  chatType?: 'direct' | 'group' | 'channel'
  /** Bootstrap 会话类型（用于系统提示词文件注入策略） */
  sessionType?: 'main' | 'subagent' | 'group' | 'channel'
  /** Agent 权限模式（plan 为只读规划模式） */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  /** 用户消息元数据（用于结构化流程标记） */
  messageMetadata?: Record<string, unknown>
  /** 重发目标消息 ID */
  resendFromMessageId?: string
  /** 编辑后重发目标消息 ID */
  editFromMessageId?: string
}

export interface AgentGetMessageVersionsInput {
  sessionId: string
  versionGroupId: string
}

export interface AgentMessageVersionsResult {
  sessionId: string
  versionGroupId: string
  messages: AgentMessage[]
}

export interface AgentAskUserQuestionOption {
  label: string
  description: string
}

export interface AgentAskUserQuestionQuestion {
  header: string
  question: string
  options: AgentAskUserQuestionOption[]
  multiSelect: boolean
}

export interface AgentAskUserQuestionRequest {
  sessionId: string
  /** 原始触发会话（用于子任务代理路由） */
  originSessionId?: string
  /** 子任务 runId（用于 Team 面板定位） */
  subagentRunId?: string
  toolUseId: string
  questions: AgentAskUserQuestionQuestion[]
}

export interface AgentAskUserQuestionResponseInput {
  sessionId: string
  toolUseId: string
  answers?: Record<string, string>
  canceled?: boolean
}

export type AgentToolPermissionRiskLevel = 'low' | 'medium' | 'high'

export type AgentToolPermissionDecision = 'allow_once' | 'allow_always' | 'deny'

export interface AgentToolPermissionRequest {
  sessionId: string
  /** 原始触发会话（用于子任务代理路由） */
  originSessionId?: string
  /** 子任务 runId（用于 Team 面板定位） */
  subagentRunId?: string
  requestId: string
  toolUseId: string
  toolName: string
  risk: AgentToolPermissionRiskLevel
  reason: string
  input: Record<string, unknown>
}

export interface AgentToolPermissionResponseInput {
  sessionId: string
  requestId: string
  decision: AgentToolPermissionDecision
}

// ===== Plan 模式 =====

/** Plan 阶段 */
export type PlanPhase = 'idle' | 'planning' | 'review' | 'executing' | 'executed'

/** Plan 步骤状态 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** Plan 步骤 */
export interface PlanStep {
  id: string
  text: string
  status: PlanStepStatus
  failCount: number
  lastError: string | null
}

/** Plan 文件元数据 */
export interface PlanFileMeta {
  /** 文件名 */
  name: string
  /** 完整路径 */
  path: string
  /** 创建时间 */
  createdAt: number
  /** 文件大小（字节） */
  size: number
  /** 摘要（从 front matter 提取） */
  summary?: string
}

/** Plan 状态变化事件 */
export interface PlanStateChangedEvent {
  /** 会话 ID */
  sessionId: string
  /** 当前阶段 */
  phase: PlanPhase
  /** Plan 文件路径 */
  planPath?: string
  /** 执行步骤 */
  steps?: PlanStep[]
}

// ===== Agent 流式事件载荷 =====

/**
 * Agent 流式事件（主进程 → 渲染进程推送）
 */
export interface AgentStreamEvent {
  /** 会话 ID */
  sessionId: string
  /** 事件数据 */
  event: AgentEvent
}

/** Agent 会话消息追加通知（sidecar -> web） */
export interface AgentMessageAppendedEvent {
  sessionId: string
  message: AgentMessage
}

export interface AgentRuntimeStatusChangedEvent {
  status: AgentRuntimeStatus
}

// ===== 文件浏览器 =====

/** 文件/目录条目（用于文件浏览器树形视图） */
export interface FileEntry {
  /** 文件/目录名称 */
  name: string
  /** 完整路径 */
  path: string
  /** 是否为目录 */
  isDirectory: boolean
  /** 子条目（懒加载，仅目录展开时填充） */
  children?: FileEntry[]
}

/** 文件索引条目（用于文件搜索） */
export interface FileIndexEntry {
  /** 文件/目录名称 */
  name: string
  /** 相对搜索根目录的路径 */
  path: string
  /** 条目类型 */
  type: 'file' | 'dir'
}

/** 文件搜索结果 */
export interface FileSearchResult {
  entries: FileIndexEntry[]
  total: number
}

// ===== Agent 附件 =====

/** Agent 待发送文件（UI 侧暂存） */
export interface AgentPendingFile {
  id: string
  filename: string
  size: number
  mediaType: string
  /** 图片预览 URL（blob/data URL） */
  previewUrl?: string
}

/** Agent 文件保存到 session 的输入 */
export interface AgentSaveFilesInput {
  workspaceSlug: string
  sessionId: string
  files: Array<{ filename: string; data: string }>
}

/** Agent 已保存文件信息 */
export interface AgentSavedFile {
  filename: string
  targetPath: string
}

/** Agent 复制文件夹到 session 的输入 */
export interface AgentCopyFolderInput {
  sourcePath: string
  workspaceSlug: string
  sessionId: string
}

// ===== IPC 通道常量 =====

/**
 * Agent 相关 IPC 通道常量
 */
export const AGENT_IPC_CHANNELS = {
  // 会话管理
  /** 获取会话列表 */
  LIST_SESSIONS: 'agent:list-sessions',
  /** 创建会话 */
  CREATE_SESSION: 'agent:create-session',
  /** 获取会话消息 */
  GET_MESSAGES: 'agent:get-messages',
  /** 获取单个消息版本组 */
  GET_MESSAGE_VERSIONS: 'agent:get-message-versions',
  /** 获取最近 N 条会话消息（分页） */
  GET_RECENT_MESSAGES: 'agent:get-recent-messages',
  /** 更新会话标题 */
  UPDATE_TITLE: 'agent:update-title',
  /** 更新会话模型/渠道选择 */
  UPDATE_MODEL_SELECTION: 'agent:update-model-selection',
  /** 迁移 Chat 对话消息到 Agent 会话 */
  MIGRATE_CHAT_TO_AGENT: 'agent:migrate-chat-to-agent',
  /** 置顶/取消置顶会话 */
  TOGGLE_PIN_SESSION: 'agent:toggle-pin-session',
  /** 移动会话到目标工作区 */
  MOVE_SESSION: 'agent:move-session',
  /** 删除会话 */
  DELETE_SESSION: 'agent:delete-session',
  /** 从指定消息开始截断会话（包含该消息） */
  TRUNCATE_MESSAGES_FROM: 'agent:truncate-messages-from',

  // 工作区管理
  /** 获取工作区列表 */
  LIST_WORKSPACES: 'agent:list-workspaces',
  /** 创建工作区 */
  CREATE_WORKSPACE: 'agent:create-workspace',
  /** 更新工作区 */
  UPDATE_WORKSPACE: 'agent:update-workspace',
  /** 删除工作区 */
  DELETE_WORKSPACE: 'agent:delete-workspace',

  // 标题生成
  /** 生成 Agent 会话标题 */
  GENERATE_TITLE: 'agent:generate-title',

  // 消息发送
  /** 发送消息（触发 Agent 流式响应） */
  SEND_MESSAGE: 'agent:send-message',
  /** 中止 Agent 执行 */
  STOP_AGENT: 'agent:stop',

  // 工作区能力（MCP + Skill）
  /** 获取工作区能力摘要 */
  GET_CAPABILITIES: 'agent:get-capabilities',
  /** 获取工作区 MCP 配置 */
  GET_MCP_CONFIG: 'agent:get-mcp-config',
  /** 保存工作区 MCP 配置 */
  SAVE_MCP_CONFIG: 'agent:save-mcp-config',
  /** 获取 Agent runtime tool policy */
  GET_TOOL_POLICY: 'agent:get-tool-policy',
  /** 保存 Agent runtime tool policy */
  SAVE_TOOL_POLICY: 'agent:save-tool-policy',
  /** 获取 Agent 网络代理配置 */
  GET_PROXY_SETTINGS: 'agent:get-proxy-settings',
  /** 保存 Agent 网络代理配置 */
  SAVE_PROXY_SETTINGS: 'agent:save-proxy-settings',
  /** 获取工作区 Skill 列表 */
  GET_SKILLS: 'agent:get-skills',
  /** 删除工作区 Skill */
  DELETE_SKILL: 'agent:delete-skill',
  /** 获取全局发现快照（MCP/Plugin/Marketplace/Skills） */
  GET_GLOBAL_DISCOVERY: 'agent:get-global-discovery',
  /** 重新扫描全局发现来源 */
  RESCAN_GLOBAL_DISCOVERY: 'agent:rescan-global-discovery',
  /** 获取 marketplace 详情（包含插件清单） */
  GET_GLOBAL_MARKETPLACE_DETAIL: 'agent:get-global-marketplace-detail',
  /** 安装全局 marketplace 插件 */
  INSTALL_GLOBAL_PLUGIN: 'agent:install-global-plugin',
  /** 导入全局 MCP 到工作区 */
  IMPORT_GLOBAL_MCP_TO_WORKSPACE: 'agent:import-global-mcp-to-workspace',
  /** 导入全局 Skill 到工作区 */
  IMPORT_GLOBAL_SKILL_TO_WORKSPACE: 'agent:import-global-skill-to-workspace',

  // 流式事件（主进程 → 渲染进程推送）
  /** Agent 流式事件 */
  STREAM_EVENT: 'agent:stream:event',
  /** Agent 流式完成 */
  STREAM_COMPLETE: 'agent:stream:complete',
  /** Agent 流式错误 */
  STREAM_ERROR: 'agent:stream:error',
  /** 会话有新消息追加（非当前流式回合） */
  MESSAGE_APPENDED: 'agent:message-appended',
  /** 查询 subagent run 状态（调试/观测） */
  LIST_SUBAGENT_RUNS: 'agent:list-subagent-runs',
  /** 获取当前会话 runtime status */
  GET_RUNTIME_STATUS: 'agent:get-runtime-status',
  /** AskUserQuestion 请求（sidecar -> web） */
  ASK_USER_QUESTION: 'agent:ask-user-question',
  /** AskUserQuestion 回答提交（web -> sidecar） */
  SUBMIT_ASK_USER_QUESTION: 'agent:submit-ask-user-question',
  /** 工具权限确认请求（sidecar -> web） */
  TOOL_PERMISSION_REQUEST: 'agent:tool-permission-request',
  /** 工具权限确认结果（web -> sidecar） */
  SUBMIT_TOOL_PERMISSION: 'agent:submit-tool-permission',
  /** runtime status 变化通知（sidecar -> web） */
  RUNTIME_STATUS_CHANGED: 'agent:runtime-status-changed',

  // 附件
  /** 保存文件到 Agent session 工作目录 */
  SAVE_FILES_TO_SESSION: 'agent:save-files-to-session',
  /** 打开文件夹选择对话框 */
  OPEN_FOLDER_DIALOG: 'agent:open-folder-dialog',
  /** 复制文件夹到 session 工作目录 */
  COPY_FOLDER_TO_SESSION: 'agent:copy-folder-to-session',

  // 文件系统操作
  /** 获取 session 工作路径 */
  GET_SESSION_PATH: 'agent:get-session-path',
  /** 列出目录内容 */
  LIST_DIRECTORY: 'agent:list-directory',
  /** 删除文件/空目录 */
  DELETE_FILE: 'agent:delete-file',
  /** 用系统默认应用打开文件 */
  OPEN_FILE: 'agent:open-file',
  /** 在系统文件管理器中显示文件 */
  SHOW_IN_FOLDER: 'agent:show-in-folder',
  /** 在新窗口中预览文件 */
  PREVIEW_FILE: 'agent:preview-file',
  /** 重命名文件/目录 */
  RENAME_FILE: 'agent:rename-file',
  /** 移动文件/目录到目标目录 */
  MOVE_FILE: 'agent:move-file',
  /** 列出附加目录内容（无工作区路径限制） */
  LIST_ATTACHED_DIRECTORY: 'agent:list-attached-directory',
  /** 用系统默认应用打开附加目录文件（无工作区路径限制） */
  OPEN_ATTACHED_FILE: 'agent:open-attached-file',
  /** 在文件管理器中显示附加目录文件（无工作区路径限制） */
  SHOW_ATTACHED_IN_FOLDER: 'agent:show-attached-in-folder',
  /** 重命名附加目录文件/目录（无工作区路径限制） */
  RENAME_ATTACHED_FILE: 'agent:rename-attached-file',
  /** 移动附加目录文件/目录（无工作区路径限制） */
  MOVE_ATTACHED_FILE: 'agent:move-attached-file',
  /** 搜索工作区文件（用于 @ 引用） */
  SEARCH_WORKSPACE_FILES: 'agent:search-workspace-files',

  // 标题自动生成通知（主进程 → 渲染进程推送）
  /** 标题已更新（首次对话完成后自动生成） */
  TITLE_UPDATED: 'agent:title-updated',

  // 工作区配置变化通知（主进程 → 渲染进程推送）
  /** 工作区能力变化（MCP/Skills 文件监听触发） */
  CAPABILITIES_CHANGED: 'agent:capabilities-changed',
  /** 工作区文件变化（session 目录文件监听触发，用于文件浏览器刷新） */
  WORKSPACE_FILES_CHANGED: 'agent:workspace-files-changed',

  // Plan 模式
  /** 获取 Plan 文件列表 */
  LIST_PLANS: 'agent:list-plans',
  /** 读取 Plan 文件内容 */
  READ_PLAN: 'agent:read-plan',
  /** 删除 Plan 文件 */
  DELETE_PLAN: 'agent:delete-plan',
  /** Plan 状态变化通知（主进程 → 渲染进程推送） */
  PLAN_STATE_CHANGED: 'agent:plan-state-changed',

  // 日志
  /** 写入日志（前端 -> sidecar） */
  WRITE_LOG: 'agent:write-log',
  /** 获取日志目录路径 */
  GET_LOGS_DIR: 'agent:get-logs-dir',
} as const
