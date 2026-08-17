/**
 * Lifecycle event bus types — single vocabulary shared by SDK, sidecar and web.
 * Batch 1 scope: run + turn + assistant message lifecycle only.
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
  partial: { text: string; toolUses: Array<{ id: string; name: string; partialJson: string }> }
}

export interface MessageEndDetail {
  type: 'message.end'
  message: { role: 'assistant'; content: unknown[] }
  error?: string
}

export type Batch1LifecycleDetail =
  | RunStartDetail | RunEndDetail
  | TurnStartDetail | TurnEndDetail
  | MessageStartDetail | MessageUpdateDetail | MessageEndDetail

/** Result of AGENT_IPC_CHANNELS.GET_EVENTS. */
export interface AgentEventsResult {
  threadId: string
  events: SdkEventEnvelope[]
}
