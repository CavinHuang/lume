/**
 * Core type definitions for the Agent SDK
 */

// Content block types (provider-agnostic, compatible with Anthropic format)
export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source?: any; data?: string; mimeType?: string; _meta?: Record<string, unknown> }
  | { type: 'document'; source: any; _meta?: Record<string, unknown> }

export type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: any; _meta?: Record<string, unknown> }
  | { type: 'tool_use'; id: string; response_item_id?: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | ToolResultContentBlock[]; is_error?: boolean; _meta?: Record<string, unknown> }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; response_item_id?: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }

// --------------------------------------------------------------------------
// Message Types
// --------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant'

export interface ConversationMessage {
  role: MessageRole
  content: string | ContentBlockParam[]
}

export interface UserMessage {
  type: 'user'
  message: ConversationMessage
  uuid: string
  timestamp: string
}

export interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  uuid: string
  timestamp: string
  usage?: TokenUsage
  cost?: number
}

export type Message = UserMessage | AssistantMessage

// --------------------------------------------------------------------------
// SDK Message Types (streaming events)
// --------------------------------------------------------------------------

export type SDKMessage =
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKAssistantMessage
  | SDKToolResultMessage
  | SDKResultMessage
  | SDKStreamEventMessage
  | SDKPartialMessage
  | SDKSystemMessage
  | SDKContextCompactionStartedMessage
  | SDKContextCompactionProgressMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKTaskNotificationMessage
  | SDKMemorySavedMessage
  | SDKLspDiagnosticsMessage
  | SDKRateLimitEvent
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKToolProgressMessage
  | SDKAuthStatusMessage
  | SDKFilesPersistedMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKPromptSuggestionMessage
  | SDKApiRetryMessage
  | SDKPostTurnSummaryMessage
  | SDKStreamlinedTextMessage
  | SDKStreamlinedToolUseSummaryMessage
  | SDKToolUseSummaryMessage
  | SDKSessionStateChangedMessage
  | SDKLocalCommandOutputMessage
  | SDKElicitationCompleteMessage
  | SDKRunAbortedMessage

/** Error type for SDKAssistantMessage when the turn ended due to an error. */
export type SDKAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

export interface SDKAssistantMessage {
  type: 'assistant'
  uuid?: string
  session_id?: string
  subagent_run_id?: string
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  parent_tool_use_id?: string | null
  /** Set when the assistant turn ended due to an error. */
  error?: SDKAssistantMessageError
  usage?: NormalizedProviderUsage
  usageIdentity?: UsageIdentity
  costUSD?: number
}

export interface SDKToolResultMessage {
  type: 'tool_result'
  subagent_run_id?: string
  result: {
    tool_use_id: string
    tool_name: string
    output: string
    content?: string | ToolResultContentBlock[]
    is_error?: boolean
    _meta?: Record<string, unknown>
  }
}

export interface SDKResultMessage {
  type: 'result'
  subtype:
    | 'success'
    | 'error_max_turns'
    | 'error_during_execution'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
    | string
  uuid?: string
  session_id?: string
  is_error?: boolean
  num_turns?: number
  result?: string
  stop_reason?: string | null
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  usage?: TokenUsage
  /** @deprecated Use modelUsage (camelCase). Kept for backward compatibility. */
  model_usage?: Record<string, { input_tokens: number; output_tokens: number }>
  /**
   * Per-model usage statistics (camelCase).
   * Compatible with official Claude Agent SDK format.
   */
  modelUsage?: Record<string, ModelUsage>
  /**
   * Per-provider-call usage records for host/runtime observability.
   */
  usageRecords?: SDKUsageRecord[]
  billingUsage?: BillingUsageSummary
  contextUsage?: ContextUsageSnapshot
  progressUsage?: AgentProgressUsage
  permission_denials?: SDKPermissionDenial[]
  structured_output?: unknown
  errors?: string[]
  /** @deprecated Use total_cost_usd */
  cost?: number
}

/**
 * Streaming event in the official Claude Agent SDK format.
 *
 * `event` follows the Anthropic streaming event structure, e.g.:
 * - Text delta:      `{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '...' } }`
 * - Tool input delta:`{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '...' } }`
 *
 * Compatible with `@anthropic-ai/claude-agent-sdk` stream_event messages.
 */
export interface SDKStreamEventMessage {
  type: 'stream_event'
  subagent_run_id?: string
  event: {
    type: string
    [key: string]: unknown
  }
  parent_tool_use_id: string | null
  uuid?: string
  session_id?: string
}

/**
 * @deprecated Use SDKStreamEventMessage (type: 'stream_event') instead.
 * Kept for backward compatibility with existing consumers.
 */
export interface SDKPartialMessage {
  type: 'partial_message'
  partial: {
    type: 'text' | 'tool_use'
    text?: string
    name?: string
    input?: string
  }
}

/** Emitted once at session start with initialization info. */
export interface SDKSystemMessage {
  type: 'system'
  subtype: 'init'
  uuid?: string
  session_id: string
  tools: string[]
  model: string
  cwd: string
  mcp_servers: Array<{ name: string; status: string }>
  permission_mode: string
  permissionMode?: PermissionMode
  agents?: string[]
  apiKeySource?: string
  slash_commands?: string[]
  skills?: string[]
  plugins?: Array<{ name: string; path: string; source?: string }>
  output_style?: string
  claude_code_version?: string
}

/** Emitted via onAsyncEvent when a run is aborted; lists tool calls that never completed. */
export interface SDKRunAbortedMessage {
  type: 'system'
  subtype: 'run_aborted'
  session_id: string
  pending_tool_calls: Array<{ id: string; name: string; input: unknown }>
}

export interface SDKLspDiagnosticsMessage {
  type: 'system'
  subtype: 'lsp_diagnostics'
  session_id?: string
  tool_use_id?: string
  file_path: string
  mutation_version: number
  sha256: string
  delayed: boolean
  diagnostics: LspDiagnosticBatch
}

export interface LspDiagnosticBatch {
  servers: string[]
  total: number
  errors: number
  warnings: number
  truncated: boolean
  items: Array<{
    server?: string
    source?: string
    severity?: 1 | 2 | 3 | 4
    code?: string | number
    message: string
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
  }>
  artifact?: FileResultRef
}

export interface LspWritethroughResult {
  servers: string[]
  formatted: boolean
  diagnostics?: LspDiagnosticBatch
  diagnosticsDelayed: boolean
  mutationVersion: number
}

export type AgentContextCompactionTrigger = 'auto' | 'manual' | 'prompt_too_long'
export type AgentContextCompactionStage = 'summarizing' | 'rewriting_context'

export interface AgentContextCompactionMetadata {
  policy?: string
  source?: string
  contextWindow?: number
  budget?: {
    totalTokens?: number
    usedTokens?: number
    remainingTokens?: number
    sections?: {
      system?: number
      memory?: number
      session?: number
      toolSchemas?: number
      reservedOutput?: number
    }
  }
  sourceMessageIds?: string[]
  preservedSegment?: {
    head_uuid?: string
    anchor_uuid?: string
    tail_uuid?: string
  }
  outcome?: 'succeeded' | 'failed'
  failureReason?: import('./utils/compact.js').CompactionFailureReason
  retainedTokens?: number
  retainedMessageCount?: number
  [key: string]: unknown
}

export interface AgentContextCompactionBoundary {
  trigger: AgentContextCompactionTrigger
  preTokens: number
  postTokens?: number
  summary?: string
  metadata?: AgentContextCompactionMetadata
}

export interface AgentContextCompactionProgress {
  trigger: AgentContextCompactionTrigger
  preTokens: number
  stage: AgentContextCompactionStage | string
  progress: number
  message?: string
  metadata?: AgentContextCompactionMetadata
}

export interface AgentContextController {
  shouldAutoCompact?: (input: {
    messages: import('./providers/types.js').NormalizedMessageParam[]
    model: string
    state: import('./utils/compact.js').AutoCompactState
    estimatedTokens: number
    contextUsage?: ContextUsageSnapshot
  }) => boolean | Promise<boolean>
  microCompactMessages?: (input: {
    messages: import('./providers/types.js').NormalizedMessageParam[]
    model: string
  }) => import('./providers/types.js').NormalizedMessageParam[] | Promise<import('./providers/types.js').NormalizedMessageParam[]>
  getCompactionMetadata?: (input: {
    messages: import('./providers/types.js').NormalizedMessageParam[]
    model: string
    state: import('./utils/compact.js').AutoCompactState
    trigger: AgentContextCompactionTrigger
    preTokens: number
  }) => AgentContextCompactionMetadata | undefined | Promise<AgentContextCompactionMetadata | undefined>
  compactConversation?: (input: {
    provider: import('./providers/types.js').LLMProvider
    model: string
    messages: import('./providers/types.js').NormalizedMessageParam[]
    state: import('./utils/compact.js').AutoCompactState
    trigger: AgentContextCompactionTrigger
    preTokens: number
    protectedMessageIndex?: number
    abortSignal?: AbortSignal
  }) => Promise<{
    compacted?: boolean
    compactedMessages: import('./providers/types.js').NormalizedMessageParam[]
    summary: string
    failureReason?: import('./utils/compact.js').CompactionFailureReason
    retainedTokens?: number
    retainedMessageCount?: number
    state?: import('./utils/compact.js').AutoCompactState
    metadata?: AgentContextCompactionMetadata
    usage?: NormalizedProviderUsage
  }>
  onCompactionBoundary?: (boundary: AgentContextCompactionBoundary) => void | Promise<void>
}

export interface SDKUserMessage {
  type: 'user'
  message: ConversationMessage
  parent_tool_use_id?: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: 'now' | 'next' | 'later'
  timestamp?: string
  uuid?: string
  session_id?: string
}

export interface SDKUserMessageReplay extends SDKUserMessage {
  isReplay: true
  uuid: string
  session_id: string
}

/** Marks a compaction boundary in the conversation. */
export interface SDKCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  /** Metadata about the compaction operation (official SDK format). */
  compact_metadata?: {
    trigger: AgentContextCompactionTrigger
    pre_tokens: number
    post_tokens?: number
    context_window?: number
    budget?: AgentContextCompactionMetadata['budget']
    summary?: string
    policy?: string
    source?: string
    source_message_ids?: string[]
    preserved_segment?: {
      head_uuid?: string
      anchor_uuid?: string
      tail_uuid?: string
    }
    outcome?: 'succeeded' | 'failed'
    failure_reason?: import('./utils/compact.js').CompactionFailureReason
    retained_tokens?: number
    retained_message_count?: number
  }
  /** @deprecated Use compact_metadata.trigger. */
  summary?: string
  uuid?: string
  session_id?: string
}

export interface SDKContextCompactionStartedMessage {
  type: 'system'
  subtype: 'context_compaction_started'
  compact_metadata: {
    trigger: AgentContextCompactionTrigger
    pre_tokens: number
    context_window?: number
    budget?: AgentContextCompactionMetadata['budget']
    policy?: string
    source?: string
  }
  uuid?: string
  session_id?: string
}

export interface SDKContextCompactionProgressMessage {
  type: 'system'
  subtype: 'context_compaction_progress'
  compact_metadata: {
    trigger: AgentContextCompactionTrigger
    pre_tokens: number
    stage: AgentContextCompactionStage | string
    progress: number
    message?: string
    context_window?: number
    budget?: AgentContextCompactionMetadata['budget']
    policy?: string
    source?: string
  }
  uuid?: string
  session_id?: string
}

/** Status update during long operations. */
export interface SDKStatusMessage {
  type: 'system'
  subtype: 'status'
  message?: string
  status?: string | null
  permissionMode?: PermissionMode
  uuid?: string
  session_id?: string
}

/** Task lifecycle notification. */
export interface SDKTaskNotificationMessage {
  type: 'system'
  subtype: 'task_notification'
  subagent_run_id?: string
  task_id: string
  status: string
  message?: string
  tool_use_id?: string
  output_file?: string
  summary?: string
  execution?: ToolExecutionMetadata
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  uuid?: string
  session_id: string
}

/** Persisted UI-only notification emitted by Lume's background memory worker. */
export interface SDKMemorySavedMessage {
  type: 'system'
  subtype: 'memory_saved'
  session_id: string
  run_id: string
  workspace_slug: string
  mutation_ids: string[]
  memory_ids: string[]
  summary: string
  created_at: string
  details?: Array<{
    mutationId: string
    action: string
    scope: 'global' | 'workspace'
    memoryIds: string[]
    summary: string
    undoable: boolean
  }>
  uuid?: string
}

/**
 * Rate limit info for claude.ai subscription users.
 * Compatible with official Claude Agent SDK SDKRateLimitInfo.
 */
export interface SDKRateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage'
  utilization?: number
  isUsingOverage?: boolean
}

/**
 * Rate limit event emitted when rate limit info changes.
 * Compatible with official Claude Agent SDK format (type: 'rate_limit_event').
 */
export interface SDKRateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: SDKRateLimitInfo
  uuid: string
  session_id: string
}

export interface SDKHookStartedMessage {
  type: 'system'
  subtype: 'hook_started'
  hook_id: string
  hook_name: string
  hook_event: string
  uuid?: string
  session_id: string
}

export interface SDKHookProgressMessage {
  type: 'system'
  subtype: 'hook_progress'
  hook_id: string
  hook_name: string
  hook_event: string
  stdout: string
  stderr: string
  output: string
  uuid?: string
  session_id: string
}

export interface SDKHookResponseMessage {
  type: 'system'
  subtype: 'hook_response'
  hook_id: string
  hook_name: string
  hook_event: string
  output: string
  stdout: string
  stderr: string
  exit_code?: number
  outcome: 'success' | 'error' | 'cancelled'
  uuid?: string
  session_id: string
}

export interface SDKToolProgressMessage {
  type: 'tool_progress'
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds: number
  task_id?: string
  uuid?: string
  session_id: string
}

export interface SDKAuthStatusMessage {
  type: 'auth_status'
  isAuthenticating: boolean
  output: string[]
  error?: string
  uuid?: string
  session_id: string
}

export interface SDKFilesPersistedMessage {
  type: 'system'
  subtype: 'files_persisted'
  files: Array<{ filename: string; file_id: string }>
  failed: Array<{ filename: string; error: string }>
  processed_at: string
  uuid?: string
  session_id: string
}

export interface SDKTaskStartedMessage {
  type: 'system'
  subtype: 'task_started'
  subagent_run_id?: string
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
  output_file?: string
  uuid?: string
  session_id: string
}

export interface SDKTaskProgressMessage {
  type: 'system'
  subtype: 'task_progress'
  subagent_run_id?: string
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  uuid?: string
  session_id: string
}

export interface SDKPromptSuggestionMessage {
  type: 'prompt_suggestion'
  suggestion: string
  uuid?: string
  session_id: string
}

export interface SDKApiRetryMessage {
  type: 'system'
  subtype: 'api_retry'
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: SDKAssistantMessageError
  phase?: 'waiting' | 'retrying' | 'cleared'
  uuid?: string
  session_id: string
}

export interface SDKPermissionDenial {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

export interface SDKPostTurnSummaryMessage {
  type: 'system'
  subtype: 'post_turn_summary'
  summarizes_uuid: string
  status_category: 'blocked' | 'waiting' | 'completed' | 'review_ready' | 'failed'
  status_detail: string
  is_noteworthy: boolean
  title: string
  description: string
  recent_action: string
  needs_action: string
  artifact_urls: string[]
  uuid?: string
  session_id: string
}

export interface SDKStreamlinedTextMessage {
  type: 'streamlined_text'
  text: string
  uuid?: string
  session_id: string
}

export interface SDKStreamlinedToolUseSummaryMessage {
  type: 'streamlined_tool_use_summary'
  tool_summary: string
  uuid?: string
  session_id: string
}

export interface SDKToolUseSummaryMessage {
  type: 'tool_use_summary'
  summary: string
  preceding_tool_use_ids: string[]
  uuid?: string
  session_id: string
}

export interface SDKSessionStateChangedMessage {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
  uuid?: string
  session_id: string
}

export interface SDKLocalCommandOutputMessage {
  type: 'system'
  subtype: 'local_command_output'
  content: string
  uuid?: string
  session_id: string
}

export interface SDKElicitationCompleteMessage {
  type: 'system'
  subtype: 'elicitation_complete'
  mcp_server_name: string
  elicitation_id: string
  uuid?: string
  session_id: string
}

// --------------------------------------------------------------------------
// Token Usage
// --------------------------------------------------------------------------

export type ProviderCallKind =
  | 'conversation'
  | 'compaction'
  | 'subagent'
  | 'title'
  | 'memory'
  | 'classifier'
  | 'side_query'

export interface UsageIdentity {
  threadId: string
  runId?: string
  parentThreadId?: string
  parentRunId?: string
  subagentRunId?: string
  responseId?: string
  turn?: number
  callerKind: ProviderCallKind
  callerLabel?: string
}

export interface NormalizedProviderUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
}

export interface ContextUsageSnapshot extends NormalizedProviderUsage {
  source: 'provider' | 'estimated'
  estimatedTailTokens: number
  sections?: {
    systemTokens: number
    memoryTokens: number
    toolSchemaTokens: number
    messageTokens: number
  }
  contextWindow: number
  contextWindowSource: 'model' | 'provider' | 'fallback'
}

export interface BillingUsageRecord extends NormalizedProviderUsage {
  usageIdentity: UsageIdentity
  callerLabel: string
  model: string
  costUSD: number
  turn?: number
  ttftMs?: number
}

export interface BillingUsageSummary {
  cumulative: NormalizedProviderUsage
  latestRecord?: BillingUsageRecord
  records: BillingUsageRecord[]
  totalCostUSD: number
}

export interface AgentProgressUsage extends NormalizedProviderUsage {}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/**
 * Per-model usage statistics (camelCase, compatible with official Claude Agent SDK).
 * Returned in SDKResultMessage.modelUsage.
 */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /** Number of web search requests made (0 if none) */
  webSearchRequests: number
  /** Estimated cost in USD for this model */
  costUSD: number
  /** Context window size for the model */
  contextWindow: number
  /** Maximum output tokens for the model */
  maxOutputTokens: number
}

export interface SDKUsageRecord {
  callerLabel: string
  model: string
  usageIdentity?: UsageIdentity
  callerKind?: ProviderCallKind
  threadId?: string
  runId?: string
  parentThreadId?: string
  parentRunId?: string
  subagentRunId?: string
  responseId?: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens?: number
  costUSD: number
  turn?: number
  ttftMs?: number
}

// --------------------------------------------------------------------------
// Tool Types
// --------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: any, context: ToolContext) => Promise<ToolResult>
  /** Validate the permission-adjusted input before hooks and side effects. */
  validateInput?: (input: any, context: ToolContext) => void | string | Promise<void | string>
  /** Optional provider-independent output description for hosts and inspectors. */
  outputSchema?: Record<string, unknown>
  /** Resolve the primary path for permission metadata and diagnostics. */
  getPath?: (input: any, context: ToolContext) => string | undefined | Promise<string | undefined>
  isReadOnly?: (input?: unknown, context?: ToolContext) => boolean
  isConcurrencySafe?: (input?: unknown, context?: ToolContext) => boolean
  isEnabled?: () => boolean
  prompt?: (context: ToolContext) => Promise<string>
  runtimeMetadata?: Record<string, unknown>
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolContext {
  cwd: string
  abortSignal?: AbortSignal
  /** Parent agent's LLM provider (inherited by subagents) */
  provider?: import('./providers/types.js').LLMProvider
  /** Parent agent's model ID */
  model?: string
  /** Parent agent's API type */
  apiType?: import('./providers/types.js').ApiType
  sessionId?: string
  /** Host Run identity used to correlate durable process jobs. */
  runId?: string
  /** Current user message used to group file checkpoints. */
  currentUserMessageId?: string
  /** Update the active working directory for subsequent tool calls in this session. */
  setWorkingDirectory?: (cwd: string) => void
  toolUseId?: string
  additionalDirectories?: string[]
  sandbox?: SandboxSettings
  toolConfig?: Record<string, unknown>
  fileStateCache?: import('./utils/fileCache.js').FileStateCache
  permissionMode?: PermissionMode
  emitEvent?: (event: SDKMessage) => void
  /** Hook registry for firing lifecycle hooks (e.g. SubagentStart/Stop). */
  hookRegistry?: import('./hooks.js').HookRegistry
  onSubagentStart?: (params: { runId: string; parentThreadId: string; agentType: string; task: string }) => void
  onSubagentEnd?: (params: { runId: string; status: 'completed' | 'errored' | 'aborted'; output?: string; error?: string }) => Promise<void> | void
  /** Called by a background tool when its process reaches a terminal state. */
  onBackgroundTaskCompleted?: () => void
  skillRegistry?: import('./skills/registry.js').SkillRegistry
  /** Session-owned directory for private, large tool result artifacts. */
  artifactsRoot?: string
  /** Host runtime observation hook; never included in provider-facing messages. */
  onToolExecution?: (observation: {
    toolName: string
    input: unknown
    result: ToolResult
  }) => void
  /** Called immediately before a tool executes, before filesystem side effects. */
  onBeforeToolExecution?: (observation: {
    toolName: string
    input: unknown
    userMessageId?: string
    cwd: string
  }) => Promise<void> | void
  /** Internal bridge used by ExecuteTool to run a discovered deferred tool. */
  executeDeferredTool?: (input: { toolName: string; params: unknown }) => Promise<ToolResult>
  /** Promote deferred tools into the native tools array for subsequent turns. Returns names actually promoted. */
  activateTools?: (names: string[]) => string[]
  /** Runs a registered core or deferred tool through the normal permission and event chain. */
  executeNestedTool?: (input: { toolName: string; params: unknown }) => Promise<ToolResult>
  /** Live snapshot of every tool this engine can call: native tools first, then deferred. */
  listAvailableTools?: () => Array<{ name: string; description: string; inputSchema: ToolDefinition['inputSchema'] }>
}

export interface PersistedToolContinuation {
  toolCall: {
    id: string
    name: string
    input: unknown
  }
  /** Omit when the approved original tool still needs to execute once. */
  toolResult?: ToolResult
}

export interface FileResultRef {
  kind: 'file'
  path: string
  size: number
  mimeType?: string
}

export interface ToolExecutionMetadataV1 {
  version: 1
  exitCode?: number | null
  stdoutPreview?: string
  stderrPreview?: string
  timedOut?: boolean
  aborted?: boolean
  outputLimitReached?: boolean
  durationMs: number
  command: string
  shell?: 'bash' | 'powershell'
  semanticOutcome?: 'no_matches' | 'condition_false' | 'files_differ'
  purpose?: string
  workspaceChanged?: boolean
  resultRef?: FileResultRef
  terminationReason: 'completed' | 'nonzero' | 'timeout' | 'aborted' | 'output_limit' | 'spawn_error' | 'running'
}

export interface ToolExecutionMetadataV2 {
  version: 2
  outcome: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted'
  exitCode?: number | null
  stdoutPreview?: string
  stderrPreview?: string
  stdoutRef?: FileResultRef
  stderrRef?: FileResultRef
  timedOut?: boolean
  aborted?: boolean
  outputLimitReached?: boolean
  durationMs: number
  command: string
  shell: 'bash' | 'powershell'
  semanticOutcome?: 'no_matches' | 'condition_false' | 'files_differ'
  purpose?: string
  workspaceChanged?: boolean
  resultRef?: FileResultRef
  terminationReason: 'completed' | 'nonzero' | 'timeout' | 'aborted' | 'output_limit' | 'spawn_error' | 'running' | 'interrupted'
}

export type ToolExecutionMetadata = ToolExecutionMetadataV1 | ToolExecutionMetadataV2

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | ToolResultContentBlock[]
  is_error?: boolean
  _meta?: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Permission Types
// --------------------------------------------------------------------------

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

/**
 * Permission update command (discriminated union).
 * Compatible with official Claude Agent SDK PermissionUpdate.
 */
export type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination }

export interface CanUseToolMetadata {
  toolUseId?: string
  permissionSuggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
  agentId?: string
}

export type CanUseToolResult = {
  behavior: PermissionBehavior
  updatedInput?: unknown
  message?: string
  permissionSuggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
}

export type CanUseToolFn = (
  tool: ToolDefinition,
  input: unknown,
  metadata?: CanUseToolMetadata,
) => Promise<CanUseToolResult>

// --------------------------------------------------------------------------
// MCP Types
// --------------------------------------------------------------------------

export type McpServerConfig =
  | McpStdioConfig
  | McpSseConfig
  | McpHttpConfig

export interface McpStdioConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  sandbox?: SandboxSettings
  onElicitation?: McpElicitationHandler
  onResourceUpdate?: McpResourceUpdateHandler
}

export interface McpSseConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
  onElicitation?: McpElicitationHandler
  onResourceUpdate?: McpResourceUpdateHandler
}

export interface McpHttpConfig {
  type: 'http' | 'streamable_http'
  url: string
  headers?: Record<string, string>
  onElicitation?: McpElicitationHandler
  onResourceUpdate?: McpResourceUpdateHandler
}

export interface McpElicitationRequest {
  serverName: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitationId?: string
  requestedSchema?: Record<string, unknown>
}

export interface McpElicitationResponse {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export type McpElicitationHandler = (
  request: McpElicitationRequest,
) => Promise<McpElicitationResponse>

export interface McpResourceUpdate {
  serverName: string
  kind: 'resources' | 'tools' | 'elicitation_complete'
  uri?: string
  tool?: string
  reason?: string
  elicitationId?: string
}

export type McpResourceUpdateHandler = (
  update: McpResourceUpdate,
) => void | Promise<void>

// --------------------------------------------------------------------------
// Agent Types
// --------------------------------------------------------------------------

export interface AgentDefinition {
  description: string
  prompt: string
  /** Default skill to auto-load when this agent type is spawned. */
  defaultSkillName?: string
  tools?: string[]
  disallowedTools?: string[]
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string
  mcpServers?: Array<string | { name: string; tools?: string[] }>
  skills?: string[]
  maxTurns?: number
  criticalSystemReminder_EXPERIMENTAL?: string
}

export interface ThinkingConfig {
  type: 'adaptive' | 'enabled' | 'disabled'
  budgetTokens?: number
}

// --------------------------------------------------------------------------
// Sandbox Types
// --------------------------------------------------------------------------

export interface SandboxSettings {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  excludedCommands?: string[]
  allowUnsandboxedCommands?: boolean
  processIsolation?: SandboxProcessIsolationConfig
  network?: SandboxNetworkConfig
  filesystem?: SandboxFilesystemConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  ripgrep?: { command: string; args?: string[] }
}

export interface SandboxProcessIsolationConfig {
  /** Launch opaque child processes through an OS-enforced sandbox. */
  enabled?: boolean
  /** Fail closed when the host sandbox is unavailable or cannot start. */
  required?: boolean
  /** Extra roots visible as read-only to the child process. */
  readonlyPaths?: string[]
  /** Extra roots visible as read-write to the child process. */
  readwritePaths?: string[]
  /** Roots that remain inaccessible even if a broader root is granted. */
  deniedPaths?: string[]
  /** Preferred executable directories prepended to PATH inside the sandbox. */
  executableSearchPaths?: string[]
  /** Preserve existing command network behavior. */
  allowOutbound?: boolean
  allowLocalNetwork?: boolean
}

export interface SandboxNetworkConfig {
  allowedDomains?: string[]
  allowManagedDomainsOnly?: boolean
  allowLocalBinding?: boolean
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  httpProxyPort?: number
  socksProxyPort?: number
}

export interface SandboxFilesystemConfig {
  allowWrite?: string[]
  denyWrite?: string[]
  denyRead?: string[]
}

// --------------------------------------------------------------------------
// Output Format
// --------------------------------------------------------------------------

export interface OutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Setting Sources
// --------------------------------------------------------------------------

export type SettingSource = 'user' | 'project' | 'local'

// --------------------------------------------------------------------------
// Model Info
// --------------------------------------------------------------------------

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export interface SDKAccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
}

export interface InitializationResult {
  commands: SlashCommand[]
  agents: Array<{ name: string; description: string }>
  output_style: string
  available_output_styles: string[]
  models: ModelInfo[]
  account: SDKAccountInfo
  slash_commands?: string[]
  skills?: string[]
  plugins?: Array<{ name: string; path: string; source?: string }>
}

export interface MCPServerStatus {
  name: string
  status: 'connected' | 'disconnected' | 'error'
  enabled: boolean
  tools: string[]
  error?: string
}

export interface ContextUsageCategory {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
}

export interface ContextUsageResult {
  categories: ContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows?: Array<Array<{
    color: string
    isFilled: boolean
    categoryName: string
    tokens: number
    percentage: number
    squareFullness: number
  }>>
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  deferredBuiltinTools?: Array<{ name: string; tokens: number; isLoaded: boolean }>
  systemTools?: Array<{ name: string; tokens: number }>
  systemPromptSections?: Array<{ name: string; tokens: number }>
  agents?: Array<{ agentType: string; source: string; tokens: number }>
  slashCommands?: {
    totalCommands: number
    includedCommands: number
    tokens: number
  }
  skills?: {
    totalSkills: number
    includedSkills: number
    tokens: number
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>
  }
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  isAutoCompactEnabled: boolean
  apiUsage: TokenUsage | null
}

export interface QuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect?: boolean
}

export interface AskUserQuestionAnnotations {
  preview?: string
  notes?: string
}

export interface AskUserQuestionRequest {
  questions: AskUserQuestion[]
  answers?: Record<string, string>
  annotations?: Record<string, AskUserQuestionAnnotations>
  metadata?: {
    source?: string
  }
}

export interface AskUserQuestionResponse {
  questions: AskUserQuestion[]
  answers: Record<string, string>
  annotations?: Record<string, AskUserQuestionAnnotations>
}

export interface RewindFilesResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export interface ReloadPluginsResult {
  commands: SlashCommand[]
  agents: Array<{ name: string; description: string }>
  plugins: Array<{ name: string; path: string; source?: string }>
  mcpServers: MCPServerStatus[]
  error_count: number
}

export interface ListSessionsOptions {
  dir?: string
  limit?: number
  offset?: number
}

export interface GetSessionMessagesOptions {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export interface GetSessionInfoOptions {
  dir?: string
}

export interface SessionMutationOptions {
  dir?: string
}

export interface ForkSessionOptions {
  dir?: string
  upToMessageId?: string
  title?: string
  newSessionId?: string
}

export interface ForkSessionResult {
  sessionId: string
}

export interface SessionMessage {
  uuid: string
  role: 'user' | 'assistant' | 'system' | 'runtime'
  timestamp: string
  content: unknown
}

export interface Query {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>
  streamInput(
    input:
      | string
      | ContentBlockParam[]
      | SDKUserMessage
      | AsyncIterable<string | ContentBlockParam[] | SDKUserMessage>,
  ): Promise<void>
  interrupt(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>
  setCwd(cwd: string): Promise<void>
  getInitializationResult(): Promise<InitializationResult>
  getContextUsage(): Promise<ContextUsageResult>
  mcpServerStatus(): Promise<MCPServerStatus[]>
  setMcpServers(servers: Record<string, McpServerConfig | any>): Promise<{
    added: string[]
    removed: string[]
    errors: Record<string, string>
  }>
  reconnectMcpServer(serverName: string): Promise<MCPServerStatus | null>
  toggleMcpServer(serverName: string, enabled: boolean): Promise<MCPServerStatus | null>
  reloadPlugins(): Promise<ReloadPluginsResult>
  rewindFiles(userMessageId: string, dryRun?: boolean): Promise<RewindFilesResult>
  stopTask(taskId: string): Promise<void>
}

export interface AgentOptions {
  /** Host thread identity used for tool assembly authorization. */
  threadType?: 'main' | 'subagent' | 'group' | 'channel'
  /** LLM model ID */
  model?: string
  /**
   * API type: 'anthropic-messages' or 'openai-completions'.
   * Falls back to CODEANY_API_TYPE env var. Default: 'anthropic-messages'.
   */
  apiType?: import('./providers/types.js').ApiType
  /** Host-owned provider implementation. When set, protocol and credentials are not resolved by the SDK. */
  provider?: import('./providers/types.js').LLMProvider
  /** API key. Falls back to CODEANY_API_KEY env var. */
  apiKey?: string
  /** API base URL override */
  baseURL?: string
  /** Working directory for file/shell tools */
  cwd?: string
  /** System prompt override or preset */
  systemPrompt?: string | { type: 'preset'; preset: 'default'; append?: string }
  /** Per-turn context placed after history and before the current user message. */
  runtimeContext?: string
  /** Provider prompt-cache policy selected by the host runtime. */
  promptCache?: import('./providers/types.js').PromptCachePolicy
  /** Append to default system prompt */
  appendSystemPrompt?: string
  /** Available tools (ToolDefinition[] or string[] preset) */
  tools?: ToolDefinition[] | string[] | { type: 'preset'; preset: 'default' }
  /** Host hook for final runtime visibility/policy filtering after MCP and plugin tools are assembled */
  resolveRuntimeTools?: (
    tools: ToolDefinition[],
    context: {
      cwd: string
      sessionId: string
      permissionMode?: PermissionMode
      threadType?: 'main' | 'subagent' | 'group' | 'channel'
    }
  ) => ToolDefinition[] | Promise<ToolDefinition[]>
  /** Host hook for registering SDK-generated tools added after runtime resolution. */
  registerGeneratedRuntimeTools?: (
    tools: ToolDefinition[],
    context: {
      cwd: string
      sessionId: string
      permissionMode?: PermissionMode
      threadType?: 'main' | 'subagent' | 'group' | 'channel'
    }
  ) => void | Promise<void>
  /**
   * Host-owned completion policy. Returning feedback keeps the agent loop alive
   * and presents that feedback to the model as an internal user message.
   */
  completionGuard?: () => Promise<CompletionGuardResult>
  /** Explicit skill definitions provided by the host runtime */
  skills?: import('./skills/types.js').SkillDefinition[]
  /** Explicit filesystem roots to scan for skills */
  skillsDirectories?: string[]
  /** Optional host filter for filesystem skills, called with the source root and skill directory name */
  shouldLoadFilesystemSkill?: (input: {
    root: string
    skillName: string
    skillFile: string
  }) => boolean
  /** Maximum number of agentic turns per query */
  maxTurns?: number
  /** Maximum USD budget per query */
  maxBudgetUsd?: number
  /** Extended thinking configuration */
  thinking?: ThinkingConfig
  /**
   * Alias for `thinking`. If both are set, `thinking` takes precedence.
   * Compatible with official Claude Agent SDK option name.
   */
  thinkingConfig?: ThinkingConfig
  /** Maximum thinking tokens (deprecated, use thinking.budgetTokens) */
  maxThinkingTokens?: number
  /** Structured output JSON schema */
  jsonSchema?: Record<string, unknown>
  /** Structured output format */
  outputFormat?: OutputFormat
  /** Permission handler callback */
  canUseTool?: CanUseToolFn
  /** Permission mode controlling tool approval behavior */
  permissionMode?: PermissionMode
  /**
   * Skip all permission checks (equivalent to bypassPermissions mode).
   * DANGEROUS: only use in trusted, sandboxed environments.
   * Compatible with official Claude Agent SDK option.
   */
  allowDangerouslySkipPermissions?: boolean
  /** Abort controller for cancellation */
  abortController?: AbortController
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Whether to include partial streaming events */
  includePartialMessages?: boolean
  /** Environment variables */
  env?: Record<string, string | undefined>
  /** Tool names to pre-approve without prompting */
  allowedTools?: string[]
  /** Tool names to deny */
  disallowedTools?: string[]
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig | any> // supports McpSdkServerConfig
  /** Custom subagent definitions */
  agents?: Record<string, AgentDefinition>
  /** Maximum tokens for responses */
  maxTokens?: number
  /** Resolved context window for the selected model. */
  contextWindow?: number
  /** Effort level for reasoning */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Fallback model if primary is unavailable */
  fallbackModel?: string
  /** Continue the most recent session in cwd */
  continue?: boolean
  /** Resume a specific session by ID */
  resume?: string
  /** Resume a session up to a specific message UUID */
  resumeSessionAt?: string
  /** Fork a session instead of continuing it */
  forkSession?: boolean
  /** Persist session to disk */
  persistSession?: boolean
  /** Explicit session ID */
  sessionId?: string
  /** Host Run identity for durable tool recovery. */
  runId?: string
  /** Host-owned exact tool continuations restored after a cold start. */
  toolContinuations?: PersistedToolContinuation[]
  /** Enable file checkpointing (for rewindFiles) */
  enableFileCheckpointing?: boolean
  /** Sandbox configuration */
  sandbox?: SandboxSettings
  /** Load settings from filesystem */
  settingSources?: SettingSource[]
  /** Plugin configurations */
  plugins?: Array<{ name: string; path?: string; config?: Record<string, unknown>; kind?: 'command' | 'module' | 'any' }>
  /** Extra roots (absolute) outside cwd from which plugins may be loaded */
  pluginRoots?: string[]
  /** Additional working directories */
  additionalDirectories?: string[]
  /** Default agent to use */
  agent?: string
  /** Debug mode */
  debug?: boolean
  /** Debug log file */
  debugFile?: string
  /** Tool-specific configuration */
  toolConfig?: Record<string, unknown>
  artifactsRoot?: string
  onToolExecution?: ToolContext['onToolExecution']
  onBeforeToolExecution?: ToolContext['onBeforeToolExecution']
  /** Receives tool events emitted after the originating tool call has returned. */
  onAsyncEvent?: (event: SDKMessage) => void
  /** Enable prompt suggestions */
  promptSuggestions?: boolean
  /** Event output style */
  outputStyle?: 'text' | 'json' | 'streamlined'
  /** Strict MCP config validation */
  strictMcpConfig?: boolean
  /** Extra CLI arguments */
  extraArgs?: Record<string, string | null>
  /** SDK betas to enable */
  betas?: string[]
  /** Permission prompt tool name override */
  permissionPromptToolName?: string
  /** Hook configurations */
  hooks?: Record<string, Array<{
    matcher?: string
    hooks: Array<(input: any, toolUseId: string, context: { signal: AbortSignal }) => Promise<any>>
    timeout?: number
  }>>
  /** Optional host-owned context policy bridge. Defaults preserve SDK compaction behavior. */
  contextController?: AgentContextController
}

export interface QueryResult {
  /** Final text output from the assistant */
  text: string
  /** Token usage */
  usage: TokenUsage
  /** Number of agentic turns */
  num_turns: number
  /** Duration in milliseconds */
  duration_ms: number
  /** All conversation messages */
  messages: Message[]
}

// --------------------------------------------------------------------------
// Query Engine Types
// --------------------------------------------------------------------------

export interface QueryEngineConfig {
  cwd: string
  model: string
  /** LLM provider instance (created from apiType) */
  provider: import('./providers/types.js').LLMProvider
  tools: ToolDefinition[]
  /** Tools omitted from the provider schema and reachable only through ExecuteTool. */
  deferredTools?: ToolDefinition[]
  /** Notified with the names successfully promoted by activateTools (ToolSearch) or skill-scope activation during this run. */
  onToolsActivated?: (names: string[]) => void
  systemPrompt?: string
  runtimeContext?: string
  promptCache?: import('./providers/types.js').PromptCachePolicy
  appendSystemPrompt?: string
  maxTurns: number
  maxBudgetUsd?: number
  maxTokens: number
  /** Resolved context window for the selected model. */
  contextWindow?: number
  thinking?: ThinkingConfig
  jsonSchema?: Record<string, unknown>
  outputFormat?: OutputFormat
  effort?: 'low' | 'medium' | 'high' | 'max'
  canUseTool: CanUseToolFn
  includePartialMessages: boolean
  abortSignal?: AbortSignal
  agents?: Record<string, AgentDefinition>
  /** Hook registry for lifecycle events */
  hookRegistry?: import('./hooks.js').HookRegistry
  /** Session ID for hook context */
  sessionId?: string
  /** Host Run identity for durable tool recovery. */
  runId?: string
  /** Execute or inject persisted tool calls before the next model request. */
  toolContinuations?: PersistedToolContinuation[]
  permissionMode?: PermissionMode
  promptSuggestions?: boolean
  additionalDirectories?: string[]
  sandbox?: SandboxSettings
  toolConfig?: Record<string, unknown>
  artifactsRoot?: string
  onToolExecution?: ToolContext['onToolExecution']
  onBeforeToolExecution?: ToolContext['onBeforeToolExecution']
  /** Receives terminal background events after the tool call has returned. */
  onAsyncEvent?: (event: SDKMessage) => void
  /** Capture a workspace baseline before each Coding Turn. */
  enableFileCheckpointing?: boolean
  skillRegistry?: import('./skills/registry.js').SkillRegistry
  currentUserMessageId?: string
  fileCheckpointState?: import('./utils/file-checkpoints.js').FileCheckpointState
  mcpServerStatuses?: Array<{ name: string; status: string }>
  initialization?: {
    slashCommands?: string[]
    skills?: string[]
    plugins?: Array<{ name: string; path: string; source?: string }>
    outputStyle?: 'text' | 'json' | 'streamlined'
    claudeCodeVersion?: string
    apiKeySource?: string
  }
  /** Optional host-owned context policy bridge. Defaults preserve SDK compaction behavior. */
  contextController?: AgentContextController
  /** Optional host-owned policy that can prevent natural completion. */
  completionGuard?: () => Promise<CompletionGuardResult>
}

export type CompletionGuardResult =
  | string
  | { type: 'continue'; message: string }
  | { type: 'stop'; message: string; errorCode?: string }
  | undefined

// --------------------------------------------------------------------------
// Slash Command & Agent Info (compatible with official Claude Agent SDK)
// --------------------------------------------------------------------------

/**
 * Information about an available slash command / skill.
 * Compatible with official Claude Agent SDK SlashCommand type.
 */
export interface SlashCommand {
  name: string
  description: string
  argumentHint?: string
}

/**
 * Information about an available subagent.
 * Compatible with official Claude Agent SDK AgentInfo type.
 */
export interface AgentInfo {
  name: string
  description: string
  model?: string
}

// --------------------------------------------------------------------------
// AbortError
// --------------------------------------------------------------------------

/**
 * Thrown when an operation is aborted.
 * Compatible with official Claude Agent SDK AbortError.
 */
export class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message)
    this.name = 'AbortError'
  }
}
