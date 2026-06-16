
/**
 * Agent 相关类型定义
 *
 * 包含 Agent SDK 集成所需的事件类型、线程管理、消息持久化和 IPC 通道常量。
 */

import type { SDKMessage } from "@lume/agent-sdk"
import type { LumeRuntimeEvent } from "./runtime-event"
import type { LumeConfigThinkingLevel } from "./lume-config"
import type { McpTransportType } from "./mcp"
export type { SDKMessage } from "@lume/agent-sdk"
export type {
  CallMcpToolDiagnosticRequest,
  CallMcpToolDiagnosticResponse,
  GetMcpStatusRequest,
  GetMcpStatusResponse,
  LegacyMcpTransportType,
  ListMcpResourcesRequest,
  ListMcpResourcesResponse,
  McpPublicStatus,
  McpResourceSummary,
  McpServerEntry,
  McpServerStatus,
  McpToolDetail,
  McpTransportType,
  ReadMcpResourceRequest,
  ReadMcpResourceResponse,
  TestMcpServerRequest,
  TestMcpServerResponse,
  WorkspaceMcpConfig
} from "./mcp"

export interface AgentPluginDiagnostic {
  pluginId?: string
  version?: string
  severity: "info" | "warning" | "error"
  code: string
  message: string
  path?: string
}

export interface AgentPluginListItem {
  pluginId: string
  name: string
  version: string
  root: string
  manifestFormat: "lume" | "codex" | "legacy"
  description?: string
  displayName?: string
  skills: number
  hooks?: string
  mcpServers?: string
  commandTools: number
  diagnostics: AgentPluginDiagnostic[]
}

export interface AgentListPluginsResult {
  plugins: AgentPluginListItem[]
  diagnostics: AgentPluginDiagnostic[]
}

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

export type AgentRuntimePhase =
  | 'idle'
  | 'streaming'
  | 'awaiting_permission'
  | 'awaiting_user_answer'
  | 'compacting'
  | 'completed'
  | 'errored'

export interface AgentRuntimeStatus {
  threadId: string
  phase: AgentRuntimePhase
  queuedCount?: number
  interactiveKind?: 'tool_permission' | 'ask_user_question'
  requestId?: string
  toolUseId?: string
  toolName?: string
  originThreadId?: string
  subagentRunId?: string
  error?: string
  updatedAt: number
}

export type AgentModelSelectionSource = 'inherited' | 'thread-override'

export interface AgentThreadSource {
  type: 'im'
  provider: string
  accountId?: string
  accountLabel?: string
  peerKind?: string
  peerId?: string
  peerName?: string
}

// ===== Agent 线程管理 =====

/** 线程生命周期状态 */
export type AgentThreadStatus = 'active' | 'archived' | 'trashed'

/**
 * Agent 线程轻量索引项
 *
 * 存储在 ~/.lume/agent-sessions.json 中，
 * 存储在独立 Agent 线程索引中。
 */
export interface AgentThreadMeta {
  /** 线程唯一标识 */
  id: string
  /** 线程标题 */
  title: string
  /** 规范化模型引用（provider/model） */
  modelRef?: string
  /** 使用的渠道 ID */
  channelId?: string
  /** 最近一次运行使用的模型 ID */
  modelId?: string
  /** 模型选择来源：继承全局默认或线程显式覆盖 */
  modelSelectionSource?: AgentModelSelectionSource
  /** SDK 内部线程 ID（用于 resume 衔接上下文） */
  sdkThreadId?: string
  /** Runtime 线程 ID（用于显式恢复） */
  runtimeThreadId?: string
  /** 所属工作区 ID */
  workspaceId?: string
  /** 外部来源，用于按 IM 渠道等入口分组展示 */
  source?: AgentThreadSource
  /** 父线程 ID（子任务线程归属） */
  parentThreadId?: string
  /** 是否置顶 */
  pinned?: boolean
  /** 线程生命周期状态，未定义时等同 'active' */
  status?: AgentThreadStatus
  /** 进入回收站的时间戳（status 为 'trashed' 时设置） */
  trashedAt?: number
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/**
 * Agent 持久化消息
 *
 * 存储在 ~/.lume/agent-sessions/{id}.jsonl 中。
 */
export interface AgentThreadMessage {
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
  /** 原始 SDK 消息片段（优先用于原生渲染） */
  sdkMessages?: SDKMessage[]
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

export type AgentMessage = AgentThreadMessage

/**
 * Agent 消息分页加载结果
 *
 * 用于分页加载：首次仅加载尾部 N 条消息，减少传输开销。
 */
export interface AgentRecentThreadMessagesResult {
  /** 本次返回的消息列表（按时间正序） */
  messages: AgentMessage[]
  /** 线程中的总消息数 */
  total: number
  /** 是否还有更早的历史消息 */
  hasMore: boolean
}

export type AgentRecentMessagesResult = AgentRecentThreadMessagesResult

// ===== Agent 标题生成输入 =====

/** Agent 标题生成输入 */
export interface AgentGenerateTitleInput {
  /** 标题来源文本（优先使用 Agent 总结） */
  sourceText?: string
  /** 兼容旧字段：用户消息 */
  userMessage?: string
  /** 规范化模型引用（provider/model），优先于 channelId/modelId */
  modelRef?: string
  /** 渠道 ID（用于获取 API Key） */
  channelId: string
  /** 模型 ID */
  modelId: string
}

// ===== Skill 元数据 =====

/** 工作区 Skill 元数据 */
export interface SkillMeta {
  slug: string
  name: string
  description?: string
  whenToUse?: string
  allowedTools?: string[]
  argumentHint?: string
  disableModelInvocation?: boolean
  icon?: string
  version?: string
}

export interface EditableSkillMeta extends SkillMeta {
  storageScope: SkillStorageScope
  managementSurface?: SkillManagementSurface
  sourceType?: SkillSourceType
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
  parentThreadId: string
  parentRunId?: string
  rootThreadId: string
  depth: number
  childThreadId: string
  deliveryThreadId?: string
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
  ownerThreadId?: string
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

export interface ImportLocalSkillDirectoryToWorkspaceInput {
  workspaceSlug: string
  localPath: string
  overwrite?: boolean
}

export interface InstallSkillMarketItemToWorkspaceInput {
  workspaceSlug: string
  skillId: string
  overwrite?: boolean
}

export interface GlobalImportResult {
  ok: true
  imported: boolean
  reason?: string
}

export type SkillSourceType = 'built-in' | 'local' | 'github' | 'subscribed-market' | 'plugin';

export type SkillManagementSurface = 'settings' | 'market' | 'plugin';

export type SkillTrustLevel = 'trusted' | 'review-required' | 'blocked-by-default'

export type SkillInstallState = 'not-installed' | 'installed' | 'update-available'

export type SkillStorageScope = 'workspace' | 'project' | 'user'

export interface SkillCatalogItem {
  id: string
  sourceId?: string
  slug: string
  name: string
  description?: string
  icon?: string
  version?: string
  sourceType: SkillSourceType
  trustLevel: SkillTrustLevel
  installState: SkillInstallState
}

export interface SkillFileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  content?: string
  children?: SkillFileTreeNode[]
}

export interface SkillMarketCatalogResult {
  items: SkillCatalogItem[]
}

export interface GetSkillMarketCatalogInput {
  workspaceSlug: string
  includeBlockedSources?: boolean
}

export interface GetSkillMarketDetailInput {
  workspaceSlug: string
  skillSlug: string
}

export interface SkillMarketDetailResult {
  item: SkillCatalogItem
  rootPath: string
  files: SkillFileTreeNode[]
}

export interface WorkspaceSkillInput {
  workspaceSlug: string
  skillSlug: string
  storageScope?: SkillStorageScope
  cwd?: string
}

export interface SaveWorkspaceSkillInput extends WorkspaceSkillInput {
  storageScope?: SkillStorageScope
  name: string
  description?: string
  whenToUse?: string
  allowedTools?: string[]
  argumentHint?: string
  disableModelInvocation?: boolean
  version?: string
  prompt: string
}

export interface SaveWorkspaceSkillResult {
  ok: true
  skill: SkillMeta
  versionPath?: string
}

export interface ListEditableSkillsInput {
  workspaceSlug: string
  cwd?: string
}

export interface GetEditableSkillInput extends WorkspaceSkillInput {
  storageScope: SkillStorageScope
}

export interface EditableSkillDetailResult {
  skill: EditableSkillMeta
  content: string
  path: string
}

export interface SkillVersionInfo {
  path: string
  filename: string
  timestamp: string
}

export interface ListSkillVersionsInput extends WorkspaceSkillInput {}

export interface RestoreSkillVersionInput extends WorkspaceSkillInput {
  filename: string
}

export interface AnalyzeSkillImprovementInput extends WorkspaceSkillInput {
  modelRef?: string
  maxSessions?: number
  messagesPerSession?: number
}

export interface SkillImprovementUpdate {
  section: string
  change: string
  reason: string
}

export interface SkillImprovementAnalysisResult {
  skillSlug: string
  usageCount: number
  analyzedSessionIds: string[]
  updates: SkillImprovementUpdate[]
}

export interface ThreadSkillImprovementSuggestion extends SkillImprovementAnalysisResult {
  workspaceSlug: string
  storageScope: SkillStorageScope
  cwd?: string
}

export interface SkillImprovementSuggestedEvent {
  threadId: string
  workspaceSlug: string
  suggestions: ThreadSkillImprovementSuggestion[]
}

export interface ApplySkillImprovementInput extends WorkspaceSkillInput {
  updates: SkillImprovementUpdate[]
  modelRef?: string
}

export interface SkillEvolutionResult {
  success: boolean
  error?: string
  versionPath?: string
  warning?: string
}

export interface GitHubSkillReviewItem {
  slug: string
  name: string
  path: string
  description?: string
  version?: string
  riskSummary: string[]
}

export interface GitHubSkillReviewResult {
  url: string
  normalizedUrl: string
  owner: string
  repo: string
  ref: string
  rootPath: string
  reviewToken: string
  trustLevel: SkillTrustLevel
  riskSummary: string[]
  structuralIssues: string[]
  skills: GitHubSkillReviewItem[]
}

export interface GetGitHubSkillReviewInput {
  url: string
}

export interface InstallGitHubSkillToWorkspaceInput {
  url: string
  workspaceSlug: string
  reviewToken: string
  overwrite?: boolean
}

export interface InstallGitHubSkillToWorkspaceResult extends GlobalImportResult {}

// ===== Agent 发送输入 =====

/**
 * Agent 发送消息的输入参数
 */
export interface AgentSendInput {
  threadId: string
  /** 用户消息内容 */
  userMessage: string
  /** 规范化模型引用（provider/model），优先于 channelId/modelId */
  modelRef?: string
  /** 渠道 ID（用于解析 provider/baseUrl/api key） */
  channelId?: string
  /** 模型 ID */
  modelId?: string
  /** 工作区 ID（用于确定 cwd） */
  workspaceId?: string
  /** 对话类型（用于记忆 citations auto 行为） */
  chatType?: 'direct' | 'group' | 'channel'
  /** Bootstrap 线程类型（用于系统提示词文件注入策略） */
  threadType?: 'main' | 'subagent' | 'group' | 'channel'
  /** Agent 权限模式（plan 为只读规划模式） */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  /** Agent 思考等级 */
  thinkingLevel?: AgentThinkingLevel
  /** 已保存到线程文件区、并绑定到本轮用户消息的附件引用 */
  messageAttachments?: AgentMessageAttachmentInput[]
  /** 用户附加的外部目录路径（不拷贝，agent 按需从原始位置读取） */
  attachedDirectories?: string[]
  /** 用户消息元数据（用于结构化流程标记） */
  messageMetadata?: Record<string, unknown>
  /** 重发目标消息 ID */
  resendFromMessageId?: string
  /** 编辑后重发目标消息 ID */
  editFromMessageId?: string
}

export interface AgentUpdateThreadModelSelectionInput {
  threadId: string
  modelRef?: string | null
  channelId?: string | null
  modelId?: string | null
}

export interface AgentThreadMessageDispatchResult {
  ok: true
  mode: 'sent' | 'queued'
  queuedCount: number
  queuedMessage?: AgentQueuedMessage
}

export interface AgentQueuedMessage {
  id: string
  threadId: string
  text: string
  createdAt: number
}

export interface AgentPendingGuidance {
  id: string
  threadId: string
  text: string
  createdAt: number
  promotedAt: number
}

export interface AgentMessageQueueSnapshot {
  threadId: string
  queuedMessages: AgentQueuedMessage[]
  pendingGuidance: AgentPendingGuidance[]
}

export interface AgentMessageQueueInput {
  threadId: string
}

export interface AgentReorderMessageQueueInput {
  threadId: string
  orderedMessageIds: string[]
}

export interface AgentRemoveQueuedMessageInput {
  threadId: string
  queuedMessageId: string
}

export interface AgentPromoteQueuedMessageToGuidanceInput {
  threadId: string
  queuedMessageId: string
}

export interface AgentMessageQueueOperationResult {
  ok: true
  snapshot: AgentMessageQueueSnapshot
  removedMessage?: AgentQueuedMessage
  promotedGuidance?: AgentPendingGuidance
}

export interface AgentGetMessageVersionsInput {
  threadId: string
  versionGroupId: string
}

export interface AgentMessageVersionsResult {
  threadId: string
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
  threadId: string
  /** 所属 runtime runId，用于 cold-start resume 关联 checkpoint。 */
  runId?: string
  /** 原始触发线程（用于子任务代理路由） */
  originThreadId?: string
  /** 子任务 runId（用于 Team 面板定位） */
  subagentRunId?: string
  /** 子任务显示名（优先用于 UI 展示） */
  subagentLabel?: string
  toolUseId: string
  questions: AgentAskUserQuestionQuestion[]
}

export interface AgentAskUserQuestionResponseInput {
  threadId: string
  toolUseId: string
  answers?: Record<string, string>
  canceled?: boolean
}

export type AgentToolPermissionRiskLevel = 'low' | 'medium' | 'high'

export type AgentToolPermissionDecision = 'allow_once' | 'allow_always' | 'deny'

export interface AgentToolPermissionClassification {
  riskLevel: AgentToolPermissionRiskLevel | 'critical'
  reasonCode: string
  explanation: string
  shouldAsk: boolean
}

export interface AgentToolPermissionGrantSuggestion {
  fingerprint: string
  label: string
}

export interface AgentToolPermissionRequest {
  threadId: string
  /** 所属 runtime runId，用于 durable interruption / checkpoint 关联。 */
  runId?: string
  /** 原始触发线程（用于子任务代理路由） */
  originThreadId?: string
  /** 子任务 runId（用于 Team 面板定位） */
  subagentRunId?: string
  /** 子任务显示名（优先用于 UI 展示） */
  subagentLabel?: string
  requestId: string
  toolUseId: string
  toolName: string
  risk: AgentToolPermissionRiskLevel
  reason: string
  reasonCode?: string
  matchedRuleId?: string
  classification?: AgentToolPermissionClassification
  grantSuggestion?: AgentToolPermissionGrantSuggestion
  /** 当前审批策略是否允许授予“始终允许”。 */
  canAllowAlways?: boolean
  input: Record<string, unknown>
  /** 持久化 interruption 类型；自动化运行高风险工具时使用 automation_approval。 */
  interruptionType?: 'tool_approval' | 'automation_approval'
  /** 自动化任务 ID（仅 automation_approval 使用，用于管理页定位任务）。 */
  automationJobId?: string
  /** 自动化触发来源（仅 automation_approval 使用）。 */
  automationTrigger?: string
}

export interface AgentToolPermissionResponseInput {
  threadId: string
  requestId: string
  decision: AgentToolPermissionDecision
  /** 将当前审批会话切到对应权限模式；目前仅支持本线程全部允许。 */
  threadPermissionMode?: 'bypassPermissions'
}

export interface AgentPendingInteractiveState {
  threadId: string
  askUserQuestions?: AgentAskUserQuestionRequest[]
  toolPermissions?: AgentToolPermissionRequest[]
  taskApprovals?: AgentTaskApprovalRequest[]
}

export interface AgentPendingInteractiveInput {
  threadId?: string
}

export interface AgentTaskApprovalRequest {
  threadId: string
  runId?: string
  requestId: string
  contractId: string
  title: string
  message: string
  summary?: string
  stepCount: number
  expectedChanges?: {
    files?: string[]
    commands?: string[]
    tools?: string[]
    memoryWrites?: string[]
  }
  planFilePath?: string
  planVerified?: boolean
}

export interface AgentTaskApprovalResponseInput {
  threadId: string
  contractId: string
  decision: 'approve' | 'reject'
  execute?: boolean
  feedback?: string
}

export interface AgentTaskApprovalResponseResult {
  ok: boolean
  feedback?: string
  replanning?: {
    status: 'sent' | 'queued'
  }
  execution?: AgentExecuteTaskContractResult
}

export interface AgentExecuteTaskContractInput {
  threadId: string
  contractId?: string
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk'
  intent?: 'execute' | 'continue' | 'retry' | 'skip'
}

export interface AgentExecuteTaskContractResult {
  ok: boolean
  status: 'sent' | 'queued' | 'not_found' | 'not_executable'
  queuedCount?: number
  contractId?: string
  error?: string
}

export type AgentResumeRunStatus =
  | 'resumed'
  | 'waiting_for_approval'
  | 'waiting_for_user'
  | 'not_resumable'
  | 'failed'

export interface AgentResumeRunInput {
  threadId: string
  runId?: string
  interruptionId?: string
}

export interface AgentResumeRunResult {
  status: AgentResumeRunStatus
  finalOutput?: string
  error?: string
}

export type AgentTraceRedactionLevel = 'safe_summary' | 'diagnostic'

export type AgentRunTraceStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface AgentRunTraceSpan {
  id: string
  traceId: string
  parentId?: string
  type: string
  name: string
  status: AgentRunTraceStatus
  startedAt: string
  endedAt?: string
  durationMs?: number
  input?: unknown
  output?: unknown
  error?: {
    message: string
    code?: string
    stack?: string
  }
  metadata?: Record<string, unknown>
}

export interface AgentRunTrace {
  id: string
  threadId: string
  runId: string
  workspaceId?: string
  name: string
  status: AgentRunTraceStatus
  startedAt: string
  endedAt?: string
  spans: AgentRunTraceSpan[]
  metadata?: Record<string, unknown>
}

export interface AgentRunTraceInput {
  threadId: string
  runId?: string
  traceId?: string
  redactionLevel?: AgentTraceRedactionLevel
}

export interface AgentRunTraceResult {
  trace: AgentRunTrace | null
}

export type AgentRunStateStatus =
  | 'created'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_user'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentRunContinuationStatus =
  | 'ready_to_resume'
  | 'waiting_for_interruption'
  | 'tool_running'
  | 'resumed'
  | 'not_resumable'

export interface AgentRunStateSummary {
  runId: string
  threadId: string
  workspaceId?: string
  workspaceSlug?: string
  status: AgentRunStateStatus
  currentStep?: {
    id: string
    type: string
    status: string
    startedAt?: string
    endedAt?: string
    error?: string
  }
  traceId: string
  contractId?: string
  model: {
    provider: string
    modelId: string
    modelRef?: string
    channelId?: string
    contextWindow?: number
  }
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUSD?: number
  }
  pendingInterruptionCount: number
  generatedItemCount: number
  continuation?: {
    status: AgentRunContinuationStatus
    checkpoint: {
      step: 'before_model_call' | 'waiting_for_tool_result' | 'after_tool_result'
      interruptionId?: string
      toolCallId?: string
      toolName?: string
      toolKind?: string
    }
    reason?: string
    updatedAt: string
  }
  error?: {
    code: string
    message: string
    retryable?: boolean
  }
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface AgentListRunStatesInput {
  threadId: string
}

export interface AgentListRunStatesResult {
  runs: AgentRunStateSummary[]
}

export type AgentTaskRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_user'
  | 'waiting_for_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentTaskRunTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface AgentTaskRunTask {
  id: string
  title: string
  description?: string
  expectedTools?: string[]
  expectedFiles?: string[]
  status: AgentTaskRunTaskStatus
  attemptCount: number
  result?: string
  error?: string
  startedAt?: string
  endedAt?: string
  blockedReason?: string
}

export interface AgentTaskRunEvent {
  type:
    | 'task_run_created'
    | 'task_started'
    | 'task_completed'
    | 'task_failed'
    | 'task_skipped'
    | 'task_waiting'
    | 'task_run_completed'
  taskRunId: string
  contractId?: string
  taskId?: string
  message?: string
  createdAt: string
}

export interface AgentTaskRun {
  id: string
  contractId: string
  runId: string
  threadId: string
  goal: string
  summary: string
  status: AgentTaskRunStatus
  currentTaskId?: string
  tasks: AgentTaskRunTask[]
  events: AgentTaskRunEvent[]
  createdAt: string
  updatedAt: string
  completedAt?: string
}

// ===== Plan 模式 =====

/** Plan 阶段 */
export type PlanModePhase = 'idle' | 'planning' | 'awaiting_approval' | 'executing' | 'completed'

/** Plan 状态变化事件 */
export interface PlanModePhaseChangedEvent {
  threadId: string
  /** 当前阶段 */
  phase: PlanModePhase
}

// ===== Agent 流式事件载荷 =====

export interface AgentRuntimeEventNotification {
  threadId: string
  event: LumeRuntimeEvent
}

export interface AgentThreadRuntimeEventsResult {
  threadId: string
  events: LumeRuntimeEvent[]
}

export interface AgentMessageAppendedEvent {
  threadId: string
  message: AgentMessage
}

export interface AgentRuntimeStatusChangedEvent {
  status: AgentRuntimeStatus
}

export interface AgentSubagentCompletionEvent {
  threadId: string
  runId: string
  childThreadId: string
  parentToolUseId?: string
  label: string
  status: SubagentRunStatus
  outputText?: string
  errorText?: string
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
  /** 外部附加来源信息（仅外部附加项有值） */
  externalAttachment?: ExternalAttachmentMeta
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
  sourcePath?: string
  /** 图片预览 URL（blob/data URL） */
  previewUrl?: string
}

/** 已保存到线程文件区、并绑定到某条用户消息的附件引用 */
export interface AgentMessageAttachmentInput {
  id: string
  filename: string
  mediaType: string
  size: number
  threadPath: string
}

/** Agent 文件保存到 thread 的输入 */
export interface AgentSaveFilesInput {
  workspaceSlug: string
  threadId: string
  files: Array<{ filename: string; data?: string; sourcePath?: string }>
}

/** Agent 已保存文件信息 */
export interface AgentSavedFile {
  filename: string
  targetPath: string
  threadPath?: string
}

/** 读取线程文件二进制数据的输入 */
export interface AgentReadThreadFileDataInput {
  workspaceSlug?: string
  threadId: string
  path: string
}

/** 线程文件二进制数据读取结果 */
export interface AgentThreadFileDataResult {
  data: string
  size: number
}

/** 文件树展示用的外部附加来源信息 */
export interface ExternalAttachmentMeta {
  label: "外部附加"
  absoluteSourcePath: string
}

/** Agent 复制文件夹到 thread 的输入 */
export interface AgentCopyFolderInput {
  sourcePath: string
  workspaceSlug: string
  threadId: string
}

/** 工作区复制外部文件夹输入 */
export interface WorkspaceCopyFolderInput {
  sourcePath: string
  workspaceSlug: string
}

/** 工作区复制外部文件夹结果 */
export interface WorkspaceCopyFolderResult {
  ok: true
  files: AgentSavedFile[]
}

export interface PromoteFileToWorkspaceInput {
  workspaceSlug: string
  threadId: string
  filePath: string
  conflictMode?: "overwrite" | "rename"
}

export interface PromoteFileToWorkspaceResult {
  ok: true
  path: string
}

export interface WorkspaceFilePathInput {
  workspaceSlug: string
  path: string
}

export interface WorkspaceRenameFileInput extends WorkspaceFilePathInput {
  newName: string
}

export interface WorkspaceMoveFileInput extends WorkspaceFilePathInput {
  targetDir: string
}

export interface WorkspaceSaveFilesInput {
  workspaceSlug: string
  files: Array<{ filename: string; data?: string; sourcePath?: string }>
}

export interface AttachWorkspaceResourceToThreadInput {
  workspaceSlug: string
  threadId: string
  sourcePath: string
}

export interface AttachWorkspaceResourceToThreadResult {
  ok: true
  path: string
}

// ===== IPC 通道常量 =====

/** 分叉线程的输入参数 */
export interface ForkThreadInput {
  /** 源线程 ID */
  threadId: string;
  /** 从此消息 ID（含）截断，后续消息不复制 */
  upToMessageId: string;
}

/** 分叉线程的返回结果 */
export interface ForkThreadResult {
  /** 新创建的线程 ID */
  newThreadId: string;
}

/**
 * Agent 相关 IPC 通道常量
 */
export const AGENT_IPC_CHANNELS = {
  // 线程管理
  /** 获取线程列表 */
  LIST_THREADS: 'agent:list-threads',
  /** 创建线程 */
  CREATE_THREAD: 'agent:create-thread',
  /** 获取线程消息 */
  GET_THREAD_MESSAGES: 'agent:get-thread-messages',
  /** 获取线程产品级 RuntimeEvent 历史 */
  GET_THREAD_RUNTIME_EVENTS: 'agent:get-thread-runtime-events',
  /** 产品级 RuntimeEvent 实时通知 */
  RUNTIME_EVENT: 'agent:runtime-event',
  /** 获取线程单个消息版本组 */
  GET_THREAD_MESSAGE_VERSIONS: 'agent:get-thread-message-versions',
  /** 获取最近 N 条线程消息（分页） */
  GET_RECENT_THREAD_MESSAGES: 'agent:get-recent-thread-messages',
  /** 更新线程标题 */
  UPDATE_THREAD_TITLE: 'agent:update-thread-title',
  /** 更新线程模型/渠道选择 */
  UPDATE_THREAD_MODEL_SELECTION: 'agent:update-thread-model-selection',
  /** 置顶/取消置顶线程 */
  TOGGLE_PIN_THREAD: 'agent:toggle-pin-thread',
  /** 移动线程到目标工作区 */
  MOVE_THREAD: 'agent:move-thread',
  /** 删除线程 */
  DELETE_THREAD: 'agent:delete-thread',
  /** 归档线程（软删除，从侧边栏隐藏） */
  ARCHIVE_THREAD: 'agent:archive-thread',
  /** 从归档恢复线程 */
  RESTORE_THREAD: 'agent:restore-thread',
  /** 将归档线程移入回收站 */
  TRASH_THREAD: 'agent:trash-thread',
  /** 从回收站恢复线程回归档 */
  RESTORE_THREAD_FROM_TRASH: 'agent:restore-thread-from-trash',
  /** 永久删除回收站中的线程 */
  PERMANENTLY_DELETE_THREAD: 'agent:permanently-delete-thread',
  /** 列出归档线程 */
  LIST_ARCHIVED_THREADS: 'agent:list-archived-threads',
  /** 列出回收站线程 */
  LIST_TRASHED_THREADS: 'agent:list-trashed-threads',
  /** 清理过期回收站条目 */
  CLEANUP_EXPIRED_TRASH: 'agent:cleanup-expired-trash',
  /** 从指定消息开始截断线程（包含该消息） */
  TRUNCATE_THREAD_MESSAGES_FROM: 'agent:truncate-thread-messages-from',
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
  /** 生成 Agent 线程标题 */
  GENERATE_TITLE: 'agent:generate-title',

  // 消息发送
  /** 发送线程消息（触发 Agent 流式响应） */
  SEND_THREAD_MESSAGE: 'agent:send-thread-message',
  /** 追加线程消息（忙碌时进入队列，空闲时立即发送） */
  APPEND_THREAD_MESSAGE: 'agent:append-thread-message',
  /** 获取当前线程消息队列 */
  LIST_MESSAGE_QUEUE: 'agent:list-message-queue',
  /** 重排当前线程消息队列 */
  REORDER_MESSAGE_QUEUE: 'agent:reorder-message-queue',
  /** 删除一条排队消息 */
  REMOVE_QUEUED_MESSAGE: 'agent:remove-queued-message',
  /** 将排队消息提升为下一次工具调用前的引导 */
  PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE: 'agent:promote-queued-message-to-guidance',
  /** 中止 Agent 线程执行 */
  STOP_THREAD: 'agent:stop-thread',
  // 工作区能力（MCP + Skill）
  /** 获取工作区能力摘要 */
  GET_CAPABILITIES: 'agent:get-capabilities',
  /** 获取工作区 MCP 配置 */
  GET_MCP_CONFIG: 'agent:get-mcp-config',
  /** 保存工作区 MCP 配置 */
  SAVE_MCP_CONFIG: 'agent:save-mcp-config',
  /** 获取工作区 MCP 连接状态 */
  GET_MCP_STATUS: 'agent:get-mcp-status',
  /** 测试单个 MCP 服务连接 */
  TEST_MCP_SERVER: 'agent:test-mcp-server',
  /** 列出 MCP 资源 */
  LIST_MCP_RESOURCES: 'agent:list-mcp-resources',
  /** 读取 MCP 资源 */
  READ_MCP_RESOURCE: 'agent:read-mcp-resource',
  /** 诊断调用 MCP 工具 */
  CALL_MCP_TOOL: 'agent:call-mcp-tool',
  /** 获取 Agent 网络代理配置 */
  GET_PROXY_SETTINGS: 'agent:get-proxy-settings',
  /** 保存 Agent 网络代理配置 */
  SAVE_PROXY_SETTINGS: 'agent:save-proxy-settings',
  /** 获取工作区 Skill 列表 */
  GET_SKILLS: 'agent:get-skills',
  /** 获取可在设置页编辑的 Skill 列表 */
  LIST_EDITABLE_SKILLS: 'agent:list-editable-skills',
  /** 获取可在设置页编辑的单个 Skill 内容 */
  GET_EDITABLE_SKILL: 'agent:get-editable-skill',
  /** 保存工作区 Skill */
  SAVE_SKILL: 'agent:save-skill',
  /** 删除工作区 Skill */
  DELETE_SKILL: 'agent:delete-skill',
  /** 从本地目录导入 Skill 到工作区 */
  IMPORT_LOCAL_SKILL_DIRECTORY_TO_WORKSPACE: 'agent:import-local-skill-directory-to-workspace',
  /** 从技能市场条目安装 Skill 到工作区 */
  INSTALL_SKILL_MARKET_ITEM_TO_WORKSPACE: 'agent:install-skill-market-item-to-workspace',
  /** 获取技能市场聚合目录 */
  GET_SKILL_MARKET_CATALOG: 'agent:get-skill-market-catalog',
  /** 获取技能详情与文件树 */
  GET_SKILL_MARKET_DETAIL: 'agent:get-skill-market-detail',
  /** 列出工作区 Skill 的历史版本 */
  LIST_SKILL_VERSIONS: 'agent:list-skill-versions',
  /** 恢复工作区 Skill 的历史版本 */
  RESTORE_SKILL_VERSION: 'agent:restore-skill-version',
  /** 分析工作区 Skill 的改进建议 */
  ANALYZE_SKILL_IMPROVEMENT: 'agent:analyze-skill-improvement',
  /** 应用工作区 Skill 的改进建议 */
  APPLY_SKILL_IMPROVEMENT: 'agent:apply-skill-improvement',
  /** 列出已安装的插件 */
  LIST_PLUGINS: 'agent:list-plugins',
  /** Re-scan plugin directories and refresh capability list (sidecar → emits CAPABILITIES_CHANGED). */
  RELOAD_PLUGINS: 'agent:reload-plugins',
  /** 工作区 Skill 有可确认的改进建议 */
  SKILL_IMPROVEMENT_SUGGESTED: 'agent:skill-improvement-suggested',
  /** 获取 GitHub 技能安装前审查摘要 */
  GET_GITHUB_SKILL_REVIEW: 'agent:get-github-skill-review',
  /** 从 GitHub 安装技能到工作区 */
  INSTALL_GITHUB_SKILL_TO_WORKSPACE: 'agent:install-github-skill-to-workspace',

  // 流式事件（主进程 → 渲染进程推送）
  /** 线程消息追加通知 */
  MESSAGE_APPENDED: 'agent:message-appended',
  /** subagent 完成通知（不落独立 transcript message） */
  SUBAGENT_COMPLETED: 'agent:subagent-completed',
  /** 查询 subagent run 状态（调试/观测） */
  LIST_SUBAGENT_RUNS: 'agent:list-subagent-runs',
  /** 获取当前线程 runtime status */
  GET_RUNTIME_STATUS: 'agent:get-runtime-status',
  /** AskUserQuestion 请求（sidecar -> web） */
  ASK_USER_QUESTION: 'agent:ask-user-question',
  /** AskUserQuestion 回答提交（web -> sidecar） */
  SUBMIT_ASK_USER_QUESTION: 'agent:submit-ask-user-question',
  /** 工具权限确认请求（sidecar -> web） */
  TOOL_PERMISSION_REQUEST: 'agent:tool-permission-request',
  /** 工具权限确认结果（web -> sidecar） */
  SUBMIT_TOOL_PERMISSION: 'agent:submit-tool-permission',
  /** 任务清单审批结果（web -> sidecar） */
  SUBMIT_TASK_APPROVAL: 'agent:submit-task-approval',
  /** 执行或继续任务清单（web -> sidecar） */
  EXECUTE_TASK_CONTRACT: 'agent:execute-task-contract',
  /** 获取当前待处理的交互请求（用于冷启动恢复） */
  GET_PENDING_INTERACTIVE: 'agent:get-pending-interactive',
  /** runtime status 变化通知（sidecar -> web） */
  RUNTIME_STATUS_CHANGED: 'agent:runtime-status-changed',
  /** 消息队列变化通知（sidecar -> web） */
  MESSAGE_QUEUE_CHANGED: 'agent:message-queue-changed',
  /** 尝试恢复可恢复的 runtime run */
  RESUME_RUN: 'agent:resume-run',
  /** 列出线程 runtime run state 摘要 */
  LIST_RUN_STATES: 'agent:list-run-states',
  /** 获取 runtime trace（默认 safe_summary 脱敏） */
  GET_RUN_TRACE: 'agent:get-run-trace',
  // 附件
  /** 保存文件到 Agent thread 工作目录 */
  SAVE_FILES_TO_THREAD: 'agent:save-files-to-thread',
  /** 打开文件夹选择对话框 */
  OPEN_FOLDER_DIALOG: 'agent:open-folder-dialog',
  /** 复制文件夹到 thread 工作目录 */
  COPY_FOLDER_TO_THREAD: 'agent:copy-folder-to-thread',
  /** 复制文件夹到工作区共享目录 */
  COPY_FOLDER_TO_WORKSPACE: 'agent:copy-folder-to-workspace',

  // 文件系统操作
  /** 获取 thread 工作路径 */
  GET_THREAD_PATH: 'agent:get-thread-path',
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
  /** 读取 thread 文件内容用于内嵌预览 */
  READ_FILE: 'agent:read-file',
  /** 读取 thread 文件二进制数据用于图片预览 */
  READ_THREAD_FILE_DATA: 'agent:read-thread-file-data',
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
  /** 将当前任务文件提升到工作区共享文件层 */
  PROMOTE_FILE_TO_WORKSPACE: 'agent:promote-file-to-workspace',
  /** 获取工作区共享文件目录路径 */
  GET_WORKSPACE_RESOURCES_PATH: 'agent:get-workspace-resources-path',
  /** 列出工作区共享目录内容 */
  LIST_WORKSPACE_DIRECTORY: 'agent:list-workspace-directory',
  /** 删除工作区共享文件/目录 */
  DELETE_WORKSPACE_FILE: 'agent:delete-workspace-file',
  /** 用系统默认应用打开工作区共享文件 */
  OPEN_WORKSPACE_FILE: 'agent:open-workspace-file',
  /** 在系统文件管理器中显示工作区共享文件 */
  SHOW_WORKSPACE_IN_FOLDER: 'agent:show-workspace-in-folder',
  /** 预览工作区共享文件 */
  PREVIEW_WORKSPACE_FILE: 'agent:preview-workspace-file',
  /** 读取工作区共享文件内容用于内嵌预览 */
  READ_WORKSPACE_FILE: 'agent:read-workspace-file',
  /** 重命名工作区共享文件/目录 */
  RENAME_WORKSPACE_FILE: 'agent:rename-workspace-file',
  /** 移动工作区共享文件/目录 */
  MOVE_WORKSPACE_FILE: 'agent:move-workspace-file',
  /** 保存文件到工作区共享目录 */
  SAVE_FILES_TO_WORKSPACE: 'agent:save-files-to-workspace',
  /** 列出工作区根目录内容 */
  LIST_WORKSPACE_ROOT_DIRECTORY: 'agent:list-workspace-root-directory',
  /** 删除工作区根目录文件/目录 */
  DELETE_WORKSPACE_ROOT_FILE: 'agent:delete-workspace-root-file',
  /** 用系统默认应用打开工作区根目录文件 */
  OPEN_WORKSPACE_ROOT_FILE: 'agent:open-workspace-root-file',
  /** 读取工作区根目录文件内容用于内嵌预览 */
  READ_WORKSPACE_ROOT_FILE: 'agent:read-workspace-root-file',
  /** 重命名工作区根目录文件/目录 */
  RENAME_WORKSPACE_ROOT_FILE: 'agent:rename-workspace-root-file',
  /** 移动工作区根目录文件/目录 */
  MOVE_WORKSPACE_ROOT_FILE: 'agent:move-workspace-root-file',
  /** 保存文件到工作区根目录 */
  SAVE_FILES_TO_WORKSPACE_ROOT: 'agent:save-files-to-workspace-root',
  /** 将工作区共享文件或目录附加到当前线程 */
  ATTACH_WORKSPACE_RESOURCE_TO_THREAD: 'agent:attach-workspace-resource-to-thread',
  /** 搜索工作区文件（用于 @ 引用） */
  SEARCH_WORKSPACE_FILES: 'agent:search-workspace-files',

  // 标题自动生成通知（主进程 → 渲染进程推送）
  /** 标题已更新（首次对话完成后自动生成） */
  TITLE_UPDATED: 'agent:title-updated',

  // 工作区配置变化通知（主进程 → 渲染进程推送）
  /** 工作区能力变化（MCP/Skills 文件监听触发） */
  CAPABILITIES_CHANGED: 'agent:capabilities-changed',
  /** 工作区文件变化（thread 目录文件监听触发，用于文件浏览器刷新） */
  WORKSPACE_FILES_CHANGED: 'agent:workspace-files-changed',

  // Plan 模式
  /** Plan 状态变化通知（主进程 → 渲染进程推送） */
  PLAN_MODE_PHASE_CHANGED: 'agent:plan-mode-phase-changed',

  // 工作区路径
  /** 获取工作区根路径 */
  GET_WORKSPACE_ROOT_PATH: 'agent:get-workspace-root-path',

  // 日志
  /** 写入日志（前端 -> sidecar） */
  WRITE_LOG: 'agent:write-log',
  /** 获取日志目录路径 */
  GET_LOGS_DIR: 'agent:get-logs-dir',

  // 分叉
  /** 从指定消息处分叉线程 */
  FORK_THREAD: 'agent:fork-thread',
} as const
export type AgentThinkingLevel = LumeConfigThinkingLevel
