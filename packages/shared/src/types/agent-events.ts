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
  message: { role: 'assistant'; content: unknown[] }
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
  /** Compaction trigger (engine metadata.trigger; batch 5 Low-1 de-scoped field). */
  trigger?: string
  /** Completed phase outcome (batch 5 Low-2 de-scoped field). */
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
  /** Task list identity (legacy taskListId/taskRunId, normalized by the adapter). */
  taskId: string
  /** Legacy TaskProgressRuntimeEvent payload (status/tasks/message/...). */
  progress: unknown
}

export interface AdvisorReviewedDetail {
  type: 'advisor.reviewed'
  summary?: string
  /** Legacy AdvisorReviewedRuntimeEvent payload (severity/summary/details/modelRef/durationMs). */
  review: unknown
}

export interface LspDiagnosticsDetail {
  type: 'lsp.diagnostics'
  /** Fields aligned with the legacy LspDiagnosticsUpdatedRuntimeEvent. */
  toolUseId?: string
  filePath: string
  mutationVersion: number
  sha256: string
  delayed: boolean
  diagnostics: {
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
    artifact?: unknown
  }
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
  | LspDiagnosticsDetail
  | CodingReportDetail

/** Result of AGENT_IPC_CHANNELS.GET_EVENTS. */
export interface AgentEventsResult {
  threadId: string
  events: SdkEventEnvelope[]
}
