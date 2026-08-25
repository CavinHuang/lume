/**
 * SDK 消息协议类型（单源）
 *
 * 本文件是 @lume/sdk 与 @lume/shared 共用的消息协议唯一来源：
 * sdk 侧通过 re-export 保持原有导出面，shared 侧直接消费，
 * 避免 shared 反向依赖 sdk 形成包级循环依赖。
 */

import type { ToolExecutionMetadata } from './runtime-event'

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
  | SDKStreamlinedTextMessage
  | SDKStreamlinedToolUseSummaryMessage
  | SDKToolUseSummaryMessage
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
    | 'error_max_output_tokens'
    | 'error_max_structured_output_retries'
    | 'error_completion_guard'
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
  permission_denials?: SDKPermissionDenial[]
  structured_output?: unknown
  errors?: string[]
  /**
   * Machine-readable code for guard-driven stops, e.g. 'repeated_tool_call'
   * for an SDK internal repeat-guard stop. Lets hosts attribute such
   * terminations structurally instead of matching on error message text.
   */
  errorCode?: string
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

export type AgentContextCompactionTrigger = 'auto' | 'manual' | 'prompt_too_long'
export type AgentContextCompactionStage = 'summarizing' | 'rewriting_context'

export type CompactionFailureReason =
  | 'provider_error'
  | 'aborted'
  | 'max_tokens'
  | 'empty_summary'
  | 'invalid_structure'
  | 'repetitive_summary'
  | 'not_smaller'

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
  failureReason?: CompactionFailureReason
  retainedTokens?: number
  retainedMessageCount?: number
  [key: string]: unknown
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
    failure_reason?: CompactionFailureReason
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

export interface SDKLocalCommandOutputMessage {
  type: 'system'
  subtype: 'local_command_output'
  content: string
  /** Owning tool call when emitted during foreground tool execution; absent for legacy/other sources. */
  tool_use_id?: string
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
// Permission Types
// --------------------------------------------------------------------------

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'
