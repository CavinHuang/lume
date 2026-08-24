
/**
 * Agent 相关类型定义
 *
 * 包含 Agent SDK 集成所需的事件类型、线程管理、消息持久化和 IPC 通道常量。
 */

import type { SDKMessage } from "./sdk-protocol"
import type { FileRef, FileReferenceBinding } from "./file-ref"
import type { LumeRuntimeEvent } from "./runtime-event"
import type { LumeConfigThinkingLevel } from "./lume-config"
import type { McpTransportType } from "./mcp"
import type { PluginMarketplaceAsset } from "./plugin-market"
import type { PlanningOperationEnvelope, PlanningTodoRefPart } from "./planning-todo"
export type { SDKMessage } from "./sdk-protocol"
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
  /** 绑定的真实项目目录；缺失表示迁移期未绑定目录的旧项目 */
  projectPath?: string
  /** 最后一次可访问时得到的 canonical realpath key，用于离线判重 */
  realpathKey?: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

export type AgentWorkspaceAvailability = 'available' | 'unbound' | 'unavailable'

export interface AgentWorkspaceStatus {
  workspaceId: string
  availability: AgentWorkspaceAvailability
  projectPath?: string
  realpath?: string
  message?: string
}

export type AgentWorkspaceRemoveMode = 'keepHistory' | 'deleteLumeData'

export interface AgentWorkspaceRemovalImpact {
  workspaceId: string
  threads: number
  automations: number
  imAccounts: number
  imThreadBindings: number
  planningTodos: number
  planningTodoAction: 'unassigned' | 'trash'
}

export interface AgentWorkspaceRemoveResult extends AgentWorkspaceRemovalImpact {
  mode: AgentWorkspaceRemoveMode
  planningOperation: PlanningOperationEnvelope
}

export type AgentThreadFileContextMode = 'newRoot' | 'inherit' | 'fork'

export type AgentFollowUpMode = 'steer' | 'queue' | 'interrupt'

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
  /** Sidecar-issued capability for a private memory maintenance thread. */
  memoryProfile?: {
    kind: 'dream'
    jobId: string
  }
  /** 稳定文件上下文 ID：主/子 Agent 共享，用户分叉隔离 */
  fileContextId?: string
  /** 外部来源，用于按 IM 渠道等入口分组展示 */
  source?: AgentThreadSource
  /** Sidecar-owned Planning start operation that created this thread. */
  createdByPlanningOperationId?: string
  /** Durable hint for the primary Planning Todo chip; SQLite link remains authoritative. */
  planningTodoId?: string
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
  /** 该逻辑回复创建时冻结的文件引用授权绑定；旧消息不回填。 */
  fileReferenceBinding?: FileReferenceBinding
  /** 生成该消息时使用的文件引用协议版本。 */
  fileReferenceProtocolVersion?: FileReferenceProtocolVersion
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
  channelId?: string
  /** 模型 ID */
  modelId?: string
}

// ===== 欢迎页建议 =====

export interface AgentWelcomeSuggestionInput {
  workspaceSlug?: string
  workspaceName?: string
}

export interface AgentWelcomeSuggestion {
  id: string
  title: string
  prompt: string
}

export interface AgentWelcomeSuggestionsResult {
  suggestions: AgentWelcomeSuggestion[]
  source: 'model' | 'fallback'
}

// ===== Skill 元数据 =====

/** 工作区 Skill 元数据 */
export interface SkillMeta {
  slug: string
  name: string
  description?: string
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

export type AgentInvocableCapabilityKind = 'skill' | 'plugin' | 'plugin-skill'

export interface AgentInvocableCapabilityItem {
  kind: AgentInvocableCapabilityKind
  uri: string
  displayName: string
  description?: string
  source: string
  scope: SkillStorageScope | 'global-plugin' | 'workspace-plugin'
  version?: string
  fingerprint?: string
  callable: boolean
  unavailableReason?:
    | 'ambiguous'
    | 'disabled'
    | 'legacy-definition'
    | 'needs-review'
    | 'not-in-workspace'
    | 'no-invocable-skills'
  pluginId?: string
  skillSlug?: string
  icon?: PluginMarketplaceAsset
}

export interface ListInvocableCapabilitiesInput {
  workspaceSlug?: string
  cwd?: string
}

export interface ListInvocableCapabilitiesResult {
  capabilities: AgentInvocableCapabilityItem[]
  diagnostics: AgentPluginDiagnostic[]
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

export type SkillStorageScope = 'workspace' | 'project' | 'user' | 'plugin'

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
  /** 审查时解析出的不可变 commit SHA；安装下载与审查令牌均钉住该值 */
  commitSha: string
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

export type AgentTraceOrigin =
  | 'main_window'
  | 'quick_input'
  | `im.${string}`
  | 'automation'
  | 'routine'
  | 'subagent'
  | 'resume'
  | 'task'
  | 'internal'

export interface AgentTraceContext {
  /** Renderer/client correlation only; never used as a persistence key. */
  submissionId: string
  clientEventId?: string
  /** Canonical correlation id minted by the first trusted main/sidecar boundary. */
  traceId?: string
  /** Trusted boundaries overwrite or derive this value. */
  origin?: AgentTraceOrigin
  parentTraceId?: string
  parentSpanId?: string
  linkedTraceId?: string
}

/**
 * Agent 发送消息的输入参数
 */
export type AgentUserMessagePart =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'capability_ref'
      occurrenceId: string
      uri: string
    }
  | PlanningTodoRefPart

export interface AgentCapabilityReferenceView {
  uri: string
  kind: AgentInvocableCapabilityKind
  displayName: string
  icon?: PluginMarketplaceAsset
  callable: boolean
}

export interface AgentSendInput {
  threadId: string
  /** 用户消息内容 */
  userMessage: string
  /**
   * 结构化用户消息。缺失时 userMessage 被视为单个普通文本 part；
   * capability_ref 是唯一可授权显式技能/插件调用的 part。
   */
  messageParts?: AgentUserMessagePart[]
  /** 客户端逻辑提交 ID；transport 结果未知时复用，明确拒绝后重新生成。 */
  clientSubmissionId?: string
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
  /** Diff 审阅中创建、随本轮消息发送的结构化行评论。 */
  commentAttachments?: AgentDiffCommentAttachment[]
  /** 用户显式添加的浏览器标签、网页批注与 Design Tweaks。 */
  browserAttachments?: AgentBrowserAttachment[]
  /** 用户消息元数据（用于结构化流程标记） */
  messageMetadata?: Record<string, unknown>
  /** 重发目标消息 ID */
  resendFromMessageId?: string
  /** 编辑后重发目标消息 ID */
  editFromMessageId?: string
  /** End-to-end observability context. Content is correlation metadata, not authorization. */
  traceContext?: AgentTraceContext
  /** Sidecar-only start-operation identity; renderer schemas intentionally omit it. */
  trustedPlanningOperationId?: string
  /** Sidecar-only execution-context binding; renderer schemas intentionally omit it. */
  trustedPlanningClientSubmissionId?: string
  /** 运行中提交时的跟进意图;未提供时按线程/全局 followUpQueueMode 默认值处理。 */
  followUpQueueMode?: AgentFollowUpMode
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
  traceId?: string
  submissionId?: string
}

export interface AgentQueuedMessage {
  id: string
  threadId: string
  text: string
  createdAt: number
  revision: number
  status: 'queued' | 'validating' | 'blocked'
  blockedReason?: string
  messageParts?: AgentUserMessagePart[]
  messageAttachments?: AgentMessageAttachmentInput[]
  commentAttachments?: AgentDiffCommentAttachment[]
  browserAttachments?: AgentBrowserAttachment[]
  clientSubmissionId?: string
  modelRef?: string
  channelId?: string
  modelId?: string
  permissionMode?: AgentSendInput['permissionMode']
  thinkingLevel?: LumeConfigThinkingLevel
  workspaceId?: string
  desktopContextSnapshotId?: string
  capabilityFingerprints?: Array<{ uri: string; fingerprint: string }>
  followUpQueueMode?: AgentFollowUpMode
  /** Internal runtime continuation; not user-editable queue content. */
  internal?: boolean
}

export interface AgentDiffCommentAttachment {
  id: string
  origin: 'diff'
  /** comment renders as review feedback; context/modify are Files-tab selection actions. */
  intent?: 'comment' | 'context' | 'modify'
  /** Renderer-safe file identity when the attachment originates in the Files tab. */
  fileRef?: FileRef
  position: {
    path: string
    rootId?: string
    runId?: string
    side: 'left' | 'right'
    line: number
    startLine?: number
    startSide?: 'left' | 'right'
  }
  body: string
  localDiffHunk?: string
  /** Bounded selected source supplied to the model; never interpreted as an executable patch. */
  selectedContent?: string
}

export interface AgentBrowserTabAttachment {
  id: string
  origin: 'browser-tab'
  backend?: 'iab' | 'extension'
  browserId?: string
  referenceGrantId?: string
  access?: 'control'
  tabId: string
  providerTabId?: string
  title: string
  url: string
  generation?: number
  lastOpenedAt?: string
  ownerThreadId?: string
}

export interface AgentBrowserAnchor {
  kind: 'element' | 'text' | 'region'
  url: string
  generation: number
  framePath: string[]
  frameUrl?: string
  selector?: string
  role?: string
  name?: string
  title?: string
  domPath?: string
  textQuote?: { exact: string; prefix?: string; suffix?: string }
  textRange?: {
    startPath?: string
    startOffset?: number
    endPath?: string
    endOffset?: number
  }
  /** Bounded visible text captured at selection time; never treated as instructions. */
  selectedContent?: string
  immediateText?: string
  nearbyText?: string
  viewport?: { width: number; height: number; deviceScaleFactor?: number; scrollX?: number; scrollY?: number }
  markerPoint?: { x: number; y: number }
  fixed?: boolean
  scrollContainer?: { selector?: string; domPath?: string }
  rect: { x: number; y: number; width: number; height: number }
}

export interface AgentBrowserAnnotationAttachment {
  id: string
  origin: 'browser-annotation'
  tab: AgentBrowserTabAttachment
  anchor: AgentBrowserAnchor
  body: string
  screenshotRef?: string
  additionalAnchors?: AgentBrowserAnchor[]
  createdAt?: string
  theme?: string
  screenshot?: {
    ref?: string
    filename?: string
    mode?: 'off' | 'necessary' | 'always'
    width?: number
    height?: number
    deviceScaleFactor?: number
  }
  // Task 91：PR diff 评审模型字段（对齐 Codex resolved/thread/unread/author）。全可选，向后兼容。
  reviewThreadId?: string                                // 线程组 id（同一锚点多条评论归属同一线程）
  inReplyToId?: string                                   // 父评论 id（构成回复链）
  isResolved?: boolean                                   // 该线程是否已解决
  resolvedAt?: string                                    // 解决时间（ISO 8601）
  resolvedBy?: 'user' | 'agent'                          // 解决者
  author?: { kind: 'user' | 'agent'; name?: string }     // 评论作者
  readAt?: string                                        // 已读时间（ISO 8601；undefined = 未读）
}

export interface BrowserAnnotationSessionSnapshot {
  version: 2
  threadId: string
  tabId: string
  url: string
  generation: number
  mode: 'browse' | 'comment'
  selectionPurpose?: 'annotation' | 'tweaks'
  comments: AgentBrowserAnnotationAttachment[]
  activeDraft?: {
    id?: string
    anchor: AgentBrowserAnchor
    body: string
    purpose?: 'annotation' | 'tweaks'
  }
  activeDesignChange?: {                              // 新增（Codex design-edit 进行中态）
    id: string
    anchor: AgentBrowserAnchor
    declarations: AgentBrowserDesignDeclaration[]
    text?: { previousValue: string; value: string }
    comment?: string
    // Task 74：Alt 多选（Codex §1.3）——host 是 additionalAnchors 单一来源；overlay 渲染 + 移除。
    // groupId === activeDesignChange.id；每条 additionalAnchor 与主 anchor 同结构。
    additionalAnchors?: AgentBrowserAnchor[]
  }
  // Task 71：design-editor 5c 交互状态（overlay → 主进程转发/记状态用，恢复时清空）
  isDesignModifierPressed?: boolean                  // Alt 多选键按下（host 管理 additionalAnchors 用）
  isOriginalViewEnabled?: boolean                    // 显示原始视图开关（隐藏 overlay 显示原图）
  isTweaksEditorOpen?: boolean                       // tweaks 编辑器面板开关
  screenshotRef?: string
  theme?: string
  updatedAt: string
}

// 单条设计变更声明：对齐 Codex A.6，逐属性记录前后值
export interface AgentBrowserDesignDeclaration {
  property: string
  value: string
  previousValue: string
  placeholderValue?: string
}

export interface AgentBrowserDesignChangeAttachment {
  id: string
  origin: 'browser-design-change'
  tab: AgentBrowserTabAttachment
  anchor: AgentBrowserAnchor
  originalStyles: Record<string, string>
  proposedStyles: Record<string, string>
  declarations?: AgentBrowserDesignDeclaration[]   // 新增（Codex A.6 对齐，逐属性）
  groupId?: string                                  // 新增（= id，Codex groupId === designChange.id）
  text?: { previousValue: string; value: string }   // 新增（文本节点编辑）
  body?: string
  screenshotRef?: string
}

export type AgentBrowserAttachment =
  | AgentBrowserTabAttachment
  | AgentBrowserAnnotationAttachment
  | AgentBrowserDesignChangeAttachment

/** Main-agent-owned persistent Task claim used by task-linked Agent/Delegate dispatch. */
export interface AgentTaskRef {
  taskListId: string
  taskId: string
  claimToken: string
}

export type AgentSubmissionReceiptStatus =
  | 'preparing'
  | 'accepted'
  | 'queued'
  | 'paused'
  | 'started'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'interrupted'
  | 'restart_dropped'

export interface AgentSubmissionReceipt {
  clientSubmissionId: string
  payloadHash: string
  threadId: string
  status: AgentSubmissionReceiptStatus
  mode?: 'sent' | 'queued'
  queuedMessageId?: string
  createdAt: number
  updatedAt: number
  errorCode?: string
}

export interface AgentGetSubmissionReceiptInput {
  clientSubmissionId: string
}

export interface AgentGetSubmissionReceiptResult {
  receipt?: AgentSubmissionReceipt
}

export interface AgentPendingGuidance {
  id: string
  threadId: string
  text: string
  createdAt: number
  promotedAt: number
  attachmentsBrief?: string
}

export interface AgentMessageQueueSnapshot {
  threadId: string
  revision: number
  queuedMessages: AgentQueuedMessage[]
  pendingGuidance: AgentPendingGuidance[]
  /** 队列因 STOP 中断暂停(thread 级);Resume 后清除。renderer 据此显示 Resume 横幅(刷新可恢复)。 */
  paused?: boolean
}

export interface AgentMessageQueueInput {
  threadId: string
}

export interface AgentReorderMessageQueueInput {
  threadId: string
  orderedMessageIds: string[]
  expectedRevision: number
  queueOperationId: string
}

export interface AgentRemoveQueuedMessageInput {
  threadId: string
  queuedMessageId: string
  expectedRevision: number
  queueOperationId: string
}

export interface AgentRetryQueuedMessageInput {
  threadId: string
  queuedMessageId: string
  expectedRevision: number
  queueOperationId: string
}

export interface AgentResumeQueueInput {
  threadId: string
  queueOperationId: string
}

export interface AgentPromoteQueuedMessageToGuidanceInput {
  threadId: string
  queuedMessageId: string
  expectedRevision: number
  queueOperationId: string
}

export interface AgentUpdateQueuedMessageInput {
  threadId: string
  queuedMessageId: string
  expectedRevision: number
  queueOperationId: string
  userMessage: string
  messageParts?: AgentUserMessagePart[]
  messageAttachments?: AgentMessageAttachmentInput[]
  commentAttachments?: AgentDiffCommentAttachment[]
  browserAttachments?: AgentBrowserAttachment[]
}

export interface AgentMessageQueueOperationResult {
  ok: boolean
  conflict?: boolean
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

export type AgentBrowserAuthStatus =
  | 'submitted'
  | 'declined'
  | 'cancelled'
  | 'unavailable'
  | 'expired'
  | 'origin_changed'
  | 'page_changed'
  | 'locator_invalid'
  | 'submission_failed'

export interface AgentBrowserAuthField {
  id: string
  label: string
  type: string
  autocomplete?: string
  required?: boolean
}

export interface AgentBrowserAuthRequest {
  threadId: string
  runId?: string
  originThreadId?: string
  subagentRunId?: string
  subagentLabel?: string
  requestId: string
  origin: string
  reason?: string
  expiresAt: string
  fields: AgentBrowserAuthField[]
  browserSessionId?: string
  browserTurnId?: string
  tabId?: string
}

export interface AgentBrowserAuthResponseInput {
  threadId: string
  requestId: string
  status: AgentBrowserAuthStatus
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
  /** Plugin sensitive-capability context (Phase 4A interactive approval). Undefined = built-in tool approval. */
  pluginSensitive?: AgentPluginSensitiveRequest
}

/** Plugin sensitive-capability dimension on a tool permission request (Phase 4A). */
export interface AgentPluginSensitiveRequest {
  pluginId: string
  /** The SensitiveCapabilityKey being confirmed, e.g. commandTool:${name} / mcpServer:${id}. */
  capabilityKey: string
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
  browserAuthRequests?: AgentBrowserAuthRequest[]
  desktopActionRequests?: import('./computer-use').AgentDesktopActionRequest[]
  toolPermissions?: AgentToolPermissionRequest[]
}

export interface AgentPendingInteractiveInput {
  threadId?: string
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

export interface AgentDiscardInterruptedRunInput {
  threadId: string
  runId?: string
}

export interface AgentDiscardInterruptedRunResult {
  ok: boolean
  runId?: string
  error?: string
}

export interface AgentGetPendingResumeInput {
  threadId: string
}

export interface AgentGetPendingResumeResult {
  threadId: string
  hasPendingResume: boolean
  runId?: string
  reason?: string
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
  traceId?: string
  submissionId?: string
  deliveryAttemptId?: string
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

// FileRef IPC payload 契约单源在 ./file-ref（zod schema 推导，#288），此处 re-export 保持公共 API 不变。
export type {
  FileSource,
  FileRef,
  FileRefTextEncoding,
  FileRefLineEnding,
  FileRefReadResult,
  WriteFileRefInput,
  WriteFileRefResult,
  FileSelectionEditInput,
  FileSelectionEditResult,
  WatchFileRefResult,
  FileRefChangedEvent,
  FileReferenceBinding,
  ProjectFileRefGuard,
  SessionFileRefGuard,
  GuardedFileRef,
} from "./file-ref"

export type FileReferenceProtocolVersion = 1
export const FILE_REFERENCE_PROTOCOL_VERSION: FileReferenceProtocolVersion = 1

export type GuardedFileRefErrorCode =
  | 'NOT_FOUND'
  | 'OUT_OF_SCOPE'
  | 'BINDING_CHANGED'
  | 'KIND_MISMATCH'
  | 'UNAVAILABLE'
  | 'IO_ERROR'

export type GuardedFileRefValidationResult =
  | { ok: true; entry: FileEntry }
  | { ok: false; code: GuardedFileRefErrorCode; message: string }

/** 文件/目录条目（用于文件浏览器树形视图） */
export interface FileEntry {
  /** 文件/目录名称 */
  name: string
  /** 完整路径 */
  path: string
  /** 新文件工作区使用的不透明引用。 */
  ref?: FileRef
  /** 文件大小；无法读取 metadata 时省略。 */
  size?: number
  /** ISO 修改时间；无法读取 metadata 时省略。 */
  modifiedAt?: string
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
  ref?: FileRef
}

/** 文件搜索结果 */
export interface FileSearchResult {
  entries: FileIndexEntry[]
  total: number
  truncated?: boolean
  scanned?: number
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
  /** Sidecar-calculated SHA-256 of the immutable attachment snapshot. */
  contentHash?: string
  threadPath: string
  /** New records carry the server-issued reference; threadPath remains for legacy records/runtime input. */
  fileRef?: FileRef
}

/** Agent 文件保存到 thread 的输入 */
export interface AgentSaveFilesInput {
  workspaceSlug: string
  threadId: string
  clientSubmissionId?: string
  files: Array<{
    id?: string
    filename: string
    mediaType?: string
    size?: number
    data?: string
    sourcePath?: string
  }>
}

export const AGENT_ATTACHMENT_LIMITS = {
  maxCount: 10,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
} as const

/** Agent 已保存文件信息 */
export interface AgentSavedFile {
  id?: string
  filename: string
  targetPath: string
  threadPath?: string
  ref?: FileRef
  mediaType?: string
  size?: number
  contentHash?: string
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

/** 引用式附加的外部目录条目（available 表示物理目录当前是否存在） */
export interface ExternalDirEntry {
  absolutePath: string
  attachedAt: string
  available: boolean
}

/** 外部目录单层只读条目 */
export interface ExternalDirEntryItem {
  name: string
  isDirectory: boolean
  size?: number
  modifiedAt?: string
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
  /** 线程列表变更通知（push：thread-manager 在线程创建后广播，前端据此刷新列表）*/
  THREAD_LIST_CHANGED: 'agent:thread-list-changed',
  /** 获取线程消息 */
  GET_THREAD_MESSAGES: 'agent:get-thread-messages',
  /** 获取线程产品级 RuntimeEvent 历史 */
  GET_THREAD_RUNTIME_EVENTS: 'agent:get-thread-runtime-events',
  /** 产品级 RuntimeEvent 实时通知 */
  RUNTIME_EVENT: 'agent:runtime-event',
  /** 生命周期事件信封实时推送（sidecar ThreadEventBus 单写者） */
  EVENTS: 'agent:events',
  /** 拉取线程生命周期事件信封全量/快照 */
  GET_EVENTS: 'agent:get-events',
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
  /** 清空回收站（永久删除全部已 trash 线程） */
  EMPTY_TRASH: 'agent:empty-trash',
  /** 从指定消息开始截断线程（包含该消息） */
  TRUNCATE_THREAD_MESSAGES_FROM: 'agent:truncate-thread-messages-from',
  // 工作区管理
  /** 获取工作区列表 */
  LIST_WORKSPACES: 'agent:list-workspaces',
  /** 创建工作区 */
  CREATE_WORKSPACE: 'agent:create-workspace',
  /** 更新工作区 */
  UPDATE_WORKSPACE: 'agent:update-workspace',
  /** 获取项目目录可用状态 */
  GET_WORKSPACE_STATUS: 'agent:get-workspace-status',
  /** 为未绑定的旧项目绑定本地目录 */
  BIND_WORKSPACE_DIRECTORY: 'agent:bind-workspace-directory',
  /** 为目录不可用的项目重新定位 */
  RELOCATE_WORKSPACE_DIRECTORY: 'agent:relocate-workspace-directory',
  /** 获取移除项目影响范围 */
  GET_WORKSPACE_REMOVAL_IMPACT: 'agent:get-workspace-removal-impact',
  /** 移除项目（保留真实目录） */
  DELETE_WORKSPACE: 'agent:delete-workspace',

  // 标题生成
  /** 生成 Agent 线程标题 */
  GENERATE_TITLE: 'agent:generate-title',
  /** 生成欢迎页建议 */
  GENERATE_WELCOME_SUGGESTIONS: 'agent:generate-welcome-suggestions',

  // 消息发送
  /** 发送线程消息（触发 Agent 流式响应） */
  SEND_THREAD_MESSAGE: 'agent:send-thread-message',
  /** 追加线程消息（忙碌时进入队列，空闲时立即发送） */
  APPEND_THREAD_MESSAGE: 'agent:append-thread-message',
  /** 获取当前线程消息队列 */
  LIST_MESSAGE_QUEUE: 'agent:list-message-queue',
  /** 查询幂等提交 receipt */
  GET_SUBMISSION_RECEIPT: 'agent:get-submission-receipt',
  /** 终结未接受的提交并释放 prepared attachment lease */
  ABORT_SUBMISSION: 'agent:abort-submission',
  /** 重排当前线程消息队列 */
  REORDER_MESSAGE_QUEUE: 'agent:reorder-message-queue',
  /** 删除一条排队消息 */
  REMOVE_QUEUED_MESSAGE: 'agent:remove-queued-message',
  /** 重试一条排队消息 */
  RETRY_QUEUED_MESSAGE: 'agent:retry-queued-message',
  /** 恢复因 STOP 中断暂停的队列 */
  RESUME_QUEUE: 'agent:resume-queue',
  /** 以 revision/CAS 更新一条排队消息 */
  UPDATE_QUEUED_MESSAGE: 'agent:update-queued-message',
  /** 将排队消息提升为下一次工具调用前的引导 */
  PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE: 'agent:promote-queued-message-to-guidance',
  /** 中止 Agent 线程执行 */
  STOP_THREAD: 'agent:stop-thread',
  /** 清空 Agent 线程会话 */
  CLEAR_THREAD: 'agent:clear-thread',
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
  /** 获取当前运行时真正可显式调用的 Skill/插件目录 */
  LIST_INVOCABLE_CAPABILITIES: 'agent:list-invocable-capabilities',
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
  /** 查询插件审计日志（Phase 4B） */
  GET_PLUGIN_AUDIT_LOG: 'agent:get-plugin-audit-log',
  /** 获取统一插件/技能市场目录 */
  GET_MARKET_CATALOG: 'agent:get-market-catalog',
  /** 获取统一市场详情 */
  GET_MARKET_DETAIL: 'agent:get-market-detail',
  /** 检查本地/GitHub/市场条目来源 */
  INSPECT_MARKET_SOURCE: 'agent:inspect-market-source',
  /** 安装市场条目 */
  INSTALL_MARKET_ITEM: 'agent:install-market-item',
  /** 更新插件 */
  UPDATE_PLUGIN: 'agent:update-plugin',
  /** 卸载插件 */
  UNINSTALL_PLUGIN: 'agent:uninstall-plugin',
  /** 设置插件启用范围 */
  SET_PLUGIN_ENABLEMENT: 'agent:set-plugin-enablement',
  /** 设置插件 active version */
  SET_PLUGIN_ACTIVE_VERSION: 'agent:set-plugin-active-version',
  /** 检测桥接是否就绪（端口/扩展/HTTP） */
  CHECK_BRIDGE_STATUS: 'agent:check-bridge-status',
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
  /** 浏览器安全凭证请求（sidecar -> web） */
  BROWSER_AUTH_REQUEST: 'agent:browser-auth-request',
  /** 高风险桌面动作确认（sidecar -> web） */
  DESKTOP_ACTION_REQUEST: 'agent:desktop-action-request',
  /** 浏览器安全凭证提交（web -> sidecar） */
  SUBMIT_BROWSER_AUTH: 'agent:submit-browser-auth',
  /** 高风险桌面动作确认结果（web -> sidecar） */
  SUBMIT_DESKTOP_ACTION: 'agent:submit-desktop-action',
  /** 工具权限确认请求（sidecar -> web） */
  TOOL_PERMISSION_REQUEST: 'agent:tool-permission-request',
  /** 工具权限确认结果（web -> sidecar） */
  SUBMIT_TOOL_PERMISSION: 'agent:submit-tool-permission',
  /** 获取当前待处理的交互请求（用于冷启动恢复） */
  GET_PENDING_INTERACTIVE: 'agent:get-pending-interactive',
  /** runtime status 变化通知（sidecar -> web） */
  RUNTIME_STATUS_CHANGED: 'agent:runtime-status-changed',
  /** 消息队列变化通知（sidecar -> web） */
  MESSAGE_QUEUE_CHANGED: 'agent:message-queue-changed',
  /** 尝试恢复可恢复的 runtime run */
  RESUME_RUN: 'agent:resume-run',
  /** 放弃待恢复的中断 run，并清理悬空工具结果 */
  DISCARD_INTERRUPTED_RUN: 'agent:discard-interrupted-run',
  /** 查询线程是否存在待恢复的中断 run（desktop 决定是否弹恢复提示） */
  GET_PENDING_RESUME: 'agent:get-pending-resume',
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
  /** 读取旧版工作区共享文件二进制数据 */
  READ_WORKSPACE_FILE_DATA: 'agent:read-workspace-file-data',
  /** 只读列出项目绑定目录内容 */
  LIST_PROJECT_DIRECTORY: 'agent:list-project-directory',
  /** 只读读取项目绑定目录文件内容 */
  READ_PROJECT_FILE: 'agent:read-project-file',
  /** 获取当前 Coding 工作区变更集合 */
  GET_CODING_CHANGE_SET: 'agent:get-coding-change-set',
  /** 获取 Review 可用的分支与最近提交来源 */
  GET_CODING_REVIEW_SOURCES: 'agent:get-coding-review-sources',
  /** 搜索当前 Review 来源中的文件路径和 Diff hunk 内容 */
  SEARCH_CODING_REVIEW: 'agent:search-coding-review',
  /** 获取单个 Coding 文件的 old/new diff 内容 */
  GET_CODING_DIFF: 'agent:get-coding-diff',
  /** 执行经过 Sidecar 重新校验的文件或 hunk Git 操作 */
  APPLY_CODING_DIFF_ACTION: 'agent:apply-coding-diff-action',
  /** 按需读取 Diff before/after 富媒体内容 */
  GET_CODING_DIFF_MEDIA: 'agent:get-coding-diff-media',
  /** 获取源码行 Git blame 元数据 */
  GET_CODING_BLAME: 'agent:get-coding-blame',
  /** 获取经过项目边界校验的 Coding 文件打开目标 */
  GET_CODING_FILE_OPEN_TARGETS: 'agent:get-coding-file-open-targets',
  /** 获取当前 Coding 仓库可提交、可推送状态 */
  GET_CODING_REPOSITORY_PUBLISH_STATE: 'agent:get-coding-repository-publish-state',
  /** 提交已暂存内容或推送当前分支 */
  APPLY_CODING_REPOSITORY_PUBLISH_ACTION: 'agent:apply-coding-repository-publish-action',
  /** 只读读取项目绑定目录二进制文件 */
  READ_PROJECT_FILE_DATA: 'agent:read-project-file-data',
  /** 将旧版资源只读导出到项目根目录，不覆盖同名内容 */
  EXPORT_LEGACY_RESOURCE_TO_PROJECT: 'agent:export-legacy-resource-to-project',
  /** 将 session/memory/legacy 条目复制晋升到项目根（源保留，同名报错） */
  PROMOTE_FILE_REF_TO_PROJECT: 'agent:promote-file-ref-to-project',
  /** 列出作用域已引用附加的外部目录 */
  LIST_EXTERNAL_DIRS: 'agent:list-external-dirs',
  /** 引用式附加外部目录（仅记录绝对路径，不复制） */
  ADD_EXTERNAL_DIR: 'agent:add-external-dir',
  /** 移除外部目录附加记录（不动物理目录） */
  REMOVE_EXTERNAL_DIR: 'agent:remove-external-dir',
  /** 只读列出外部目录单层内容（拒绝符号链接） */
  LIST_EXTERNAL_DIR_ENTRIES: 'agent:list-external-dir-entries',
  /** 用系统默认应用打开项目绑定目录文件 */
  OPEN_PROJECT_FILE: 'agent:open-project-file',
  /** 在系统文件管理器中显示项目绑定目录文件 */
  SHOW_PROJECT_IN_FOLDER: 'agent:show-project-in-folder',
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
  /** New right-panel FileRef-only operations. */
  LIST_FILE_REF_DIRECTORY: 'agent:list-file-ref-directory',
  STAT_FILE_REF: 'agent:stat-file-ref',
  READ_FILE_REF: 'agent:read-file-ref',
  WRITE_FILE_REF: 'agent:write-file-ref',
  REQUEST_FILE_SELECTION_EDIT: 'agent:request-file-selection-edit',
  WATCH_FILE_REF: 'agent:watch-file-ref',
  UNWATCH_FILE_REF: 'agent:unwatch-file-ref',
  FILE_REF_CHANGED: 'agent:file-ref-changed',
  SEARCH_FILE_REFS: 'agent:search-file-refs',
  RESOLVE_FILE_REF: 'agent:resolve-file-ref',
  RENAME_FILE_REF: 'agent:rename-file-ref',
  MOVE_FILE_REF: 'agent:move-file-ref',
  DELETE_FILE_REF: 'agent:delete-file-ref',
  CONVERT_LEGACY_FILE_REF: 'agent:convert-legacy-file-ref',
  /** Mandatory-guard message reference operations. Never accept a plain FileRef. */
  VALIDATE_GUARDED_FILE_REF: 'agent:validate-guarded-file-ref',
  LIST_GUARDED_FILE_REF_DIRECTORY: 'agent:list-guarded-file-ref-directory',
  STAT_GUARDED_FILE_REF: 'agent:stat-guarded-file-ref',
  READ_GUARDED_FILE_REF: 'agent:read-guarded-file-ref',
  RESOLVE_GUARDED_FILE_REF: 'agent:resolve-guarded-file-ref',

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
  /** 日志目录仅供兼容旧调用；桌面 renderer 不返回真实本地路径 */
  GET_LOGS_DIR: 'agent:get-logs-dir',

  // 分叉
  /** 从指定消息处分叉线程 */
  FORK_THREAD: 'agent:fork-thread',
} as const

/** Electron main-only RPC; every call also requires a per-process privileged credential. */
export const PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS = {
  PREPARE: 'plugin-package:privileged-prepare',
  FINALIZE: 'plugin-package:privileged-finalize',
  REVOKE: 'plugin-package:privileged-revoke',
} as const
export type AgentThinkingLevel = LumeConfigThinkingLevel
