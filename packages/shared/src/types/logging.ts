export const LUME_LOG_SCHEMA_VERSION = 2 as const

export const LUME_LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const
export type LumeLogLevel = (typeof LUME_LOG_LEVELS)[number]

export const LUME_LOG_SOURCES = ["main", "sidecar", "renderer", "desktop-host", "node-repl"] as const
export type LumeLogSource = (typeof LUME_LOG_SOURCES)[number]

export type LumeLogKind = "log" | "trace"
export type LumeLogStatus = "started" | "ok" | "error" | "cancelled" | "unknown"

export interface LumeLogError {
  name?: string
  code?: string
  category?: string
  message: string
  stack?: string
  retryable?: boolean
}

export interface LumeLogCorrelation {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  parentTraceId?: string
  runId?: string
  threadId?: string
  messageId?: string
  submissionId?: string
  rpcRequestId?: string
  providerAttemptId?: string
  toolCallId?: string
  subagentRunId?: string
  deliveryAttemptId?: string
  origin?: string
}

export interface LumeLogEventV2 extends LumeLogCorrelation {
  schemaVersion: typeof LUME_LOG_SCHEMA_VERSION
  eventId: string
  emittedAt: string
  observedAt: string
  seq: number
  kind: LumeLogKind
  level: LumeLogLevel
  source: LumeLogSource
  context: string
  event: string
  message: string
  status?: LumeLogStatus
  durationMs?: number
  data?: Record<string, unknown>
  error?: LumeLogError
  internal?: boolean
}

export interface LumeLogEventInput extends LumeLogCorrelation {
  schemaVersion?: typeof LUME_LOG_SCHEMA_VERSION
  eventId?: string
  emittedAt?: string
  kind?: LumeLogKind
  level: LumeLogLevel
  source: LumeLogSource
  context: string
  event: string
  message: string
  status?: LumeLogStatus
  durationMs?: number
  data?: Record<string, unknown>
  error?: LumeLogError
  internal?: boolean
}

export interface LumeLogBatch {
  schemaVersion: typeof LUME_LOG_SCHEMA_VERSION
  batchId: string
  source: Exclude<LumeLogSource, "main">
  events: LumeLogEventInput[]
  dropped?: {
    count: number
    levels: LumeLogLevel[]
    firstAt: string
    lastAt: string
  }
}

export interface LumeLogBatchAck {
  batchId: string
  accepted: number
}

export interface LumeLogDigestPolicy {
  schemaVersion: 1
  algorithm: "hmac-sha256"
  keyVersion: number
  scope: "install" | "session"
  /** Base64-encoded derived producer key. The main-process root key is never distributed. */
  key: string
}

export interface LumeLoggingSettings {
  consoleLevel: LumeLogLevel
  fileLevel: LumeLogLevel
  format: "pretty" | "json"
  retentionDays: number
  maxSegmentMb: number
  maxTotalMb: number
  diagnosticCapture: LumeDiagnosticCaptureSettings
}

export interface LumeDiagnosticCaptureSettings {
  enabled: boolean
  configVersion: number
  expiresAt: string | null
  scope: { threadId?: string; traceId?: string } | null
}

export interface SensitiveDiagnosticEnvelope {
  schemaVersion: 1
  envelopeType: "sensitive-diagnostic"
  captureType: "user_message" | "assistant_message"
  emittedAt: string
  leaseVersion: number
  threadId: string
  traceId: string
  messageId: string
  content: string
}

export interface LumeDiagnosticStatus {
  available: boolean
  lease: LumeDiagnosticCaptureSettings | null
  deleted?: number
}

export const LUME_LOGGING_DEFAULTS: LumeLoggingSettings = {
  consoleLevel: "info",
  fileLevel: "info",
  format: "pretty",
  retentionDays: 14,
  maxSegmentMb: 20,
  maxTotalMb: 500,
  diagnosticCapture: {
    enabled: false,
    configVersion: 1,
    expiresAt: null,
    scope: null,
  },
}
