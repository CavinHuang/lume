import type { NormalizedProviderUsage } from './sdk-protocol'

/**
 * Lifecycle event bus types — single vocabulary shared by SDK, sidecar and web.
 * Batch 1 scope: run + turn + assistant message lifecycle.
 * Batch 2 scope: tool start/end skeleton.
 * Batch 5 scope: thinking folding, user message pair, domain events (final T1 table).
 */

export type SdkEventKind = 'run' | 'turn' | 'message' | 'tool'
export type SdkEventPhase = 'start' | 'update' | 'end' | 'event'

/** Envelope assigned by the sidecar ThreadEventBus (single seq writer per thread). */
export interface SdkEventEnvelope<T = unknown> {
  v: 1
  seq: number
  threadId: string
  runId: string
  turnId: string | null
  ts: number
  kind: SdkEventKind
  phase: SdkEventPhase
  detail: T
}

/** Skeleton event emitted by the SDK projector; seq/threadId are filled by the bus. */
export interface SdkLifecycleEvent<T = unknown> {
  runId: string
  turnId: string | null
  ts: number
  kind: SdkEventKind
  phase: SdkEventPhase
  detail: T
}

export interface RunStartDetail {
  type: 'run.start'
}

export interface RunEndDetail {
  type: 'run.end'
  stopReason: string | null
  isError: boolean
  numTurns: number
  /** Guard-driven stop 的结构化码(SDK repeat-guard 'repeated_tool_call' / 宿主 verification stop),随 SDKResultMessage 透传。 */
  errorCode?: string
  /** F3:错误终值携带的错误信息(流抛错/run 链内失败的补发终值);正常终值缺省。 */
  result?: string
  /** Migrated from the legacy SDKResultMessage when present. */
  usage?: Record<string, unknown>
  costUSD?: number
}

export interface TurnStartDetail {
  type: 'turn.start'
}

export interface TurnEndDetail {
  type: 'turn.end'
  /** Complete assistant message for this turn. */
  assistantMessage: { role: 'assistant'; content: unknown[] }
  /** All tool results collected during this turn, in tool_use order. */
  toolResults: Array<{ tool_use_id: string; tool_name?: string; content?: unknown; is_error?: boolean }>
}

export interface MessageStartDetail {
  type: 'message.start'
}

export interface MessageUpdateDetail {
  type: 'message.update'
  /** Native provider stream event (e.g. text_delta / input_json_delta), when available. */
  delta: { type: string; [key: string]: unknown } | null
  /** Folded cumulative partial — consumers never accumulate state themselves. */
  partial: {
    text: string
    /** Folded cumulative thinking text (batch 2 leftover, batch 5). */
    thinking: string
    toolUses: Array<{ id: string; name: string; partialJson: string }>
  }
}

export interface UserMessageDetail {
  type: 'user.message'
  /** Plain text or structured message parts (mirrors the SDK user turn input). */
  content: string | unknown[]
}

export interface MessageEndDetail {
  type: 'message.end'
  message: {
    role: 'assistant'
    content: unknown[]
    /** 本条 assistant 消息的 provider 用量（SDKAssistantMessage.usage 透传，缺省=上游未提供）。 */
    usage?: NormalizedProviderUsage
    costUSD?: number
  }
  error?: string
}

export interface ToolStartDetail {
  type: 'tool.start'
  toolCallId: string
  toolName: string
  /** Raw input; the projection layer derives the preview (legacy inputPreview path). */
  input: unknown
}

export interface ToolEndDetail {
  type: 'tool.end'
  toolCallId: string
  toolName: string
  isError: boolean
  /** Output text; the projection layer derives the preview (legacy resultPreview path). */
  output: string
  /** Engine _meta.execution passed through as-is (input of the legacy normalizeToolExecutionMetadata). */
  meta?: Record<string, unknown>
}

export interface MemoryContextUsedDetail {
  type: 'memory.context.used'
  /** Isomorphic to the legacy event.items: memory reference entries. */
  items: Array<{
    id: string
    kind: string
    scope: string
    status: string
    citation: string
    fileRef?: unknown
    reason?: string
    /** Structured memory claim (legacy MemoryClaim), not a plain string. */
    claim?: unknown
  }>
}

export interface BackgroundTaskNotificationDetail {
  type: 'background.task'
  taskId: string
  status: 'completed' | 'failed' | 'stopped' | 'cancelled'
  message?: string
  summary?: string
  execution?: unknown
}

export interface ContextCompactionDetail {
  type: 'context.compaction'
  phase: 'started' | 'progress' | 'completed'
  /** Tokens before compaction (engine compact_metadata.pre_tokens; all three phases carry it). */
  preTokens?: number
  /** Tokens after compaction (compact_metadata.post_tokens; completed phase only). */
  postTokens?: number
  /** Progress percentage (e.g. 45 of 85) while compacting. */
  progress?: number
  /** Completed phase: success or failure text. */
  result?: string
  isError?: boolean
  /** Compaction trigger 真值（engine compact_metadata.trigger 透传：'auto'|'manual'|'prompt_too_long'；缺省 'auto'）。 */
  trigger?: string
  /** Completed phase outcome（compact_metadata.outcome 透传；仅 completed 带，started/progress 省略）。 */
  outcome?: 'succeeded' | 'failed'
}

/**
 * Domain event details (batch 5, T1 final table). Payloads stay opaque at the
 * shared type level; the sidecar adapter folds the legacy RuntimeEvent shapes.
 */
export interface PlanPreviewDetail {
  type: 'plan.preview'
  /** Legacy PlanPreviewRuntimeEvent payload (contractId/title/summary/markdown/stepCount/...). */
  content: unknown
}

export interface TodoStateDetail {
  type: 'todo.state'
  /** Legacy TodoStateUpdatedRuntimeEvent payload (todos/currentActiveForm). */
  state: unknown
}

export interface TaskProgressDetail {
  type: 'task.progress'
  /** SDK background task id (system task_progress message's task_id). */
  taskId: string
  /** SDK background progress shape: description/usage (plus last_tool_name/summary/tool_use_id when present). */
  progress: unknown
}

export interface AdvisorReviewedDetail {
  type: 'advisor.reviewed'
  summary?: string
  /** Legacy AdvisorReviewedRuntimeEvent payload (severity/summary/details/modelRef/durationMs). */
  review: unknown
}

export interface CodingReportDetail {
  type: 'coding.report'
  /** Legacy RuntimeCodingReport payload (T1 verdict: migrated; dual-entry with run.completed). */
  report: unknown
}

export type SdkLifecycleDetail =
  | RunStartDetail | RunEndDetail
  | TurnStartDetail | TurnEndDetail
  | MessageStartDetail | MessageUpdateDetail | MessageEndDetail
  | UserMessageDetail
  | ToolStartDetail | ToolEndDetail
  | MemoryContextUsedDetail
  | BackgroundTaskNotificationDetail
  | ContextCompactionDetail
  | PlanPreviewDetail
  | TodoStateDetail
  | TaskProgressDetail
  | AdvisorReviewedDetail
  | CodingReportDetail

/** Result of AGENT_IPC_CHANNELS.GET_EVENTS. */
export interface AgentEventsResult {
  threadId: string
  events: SdkEventEnvelope[]
}
