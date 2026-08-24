import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stderr } from "node:process";
import type {
  LumeLogBatch,
  LumeLogEventInput,
  LumeLogCorrelation,
  LumeLogLevel,
  LumeLogStatus,
  LumeLogError,
} from "@lume/shared";
import { LUME_LOG_SCHEMA_VERSION, classifyLogKey, clipLogPreview } from "@lume/shared";

export type LogLevel = LumeLogLevel;
type LogBatchNotificationWriter = (batch: LumeLogBatch) => void;

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};
const MAX_QUEUE_EVENTS = 1_000;
const MAX_QUEUE_BYTES = 512 * 1024;
const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 128 * 1024;
const FLUSH_INTERVAL_MS = 50;
const ACK_TIMEOUT_MS = 5_000;
const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_CHARS = 8_192;

const configuredLevel = (process.env.LUME_LOG_FILE_LEVEL ?? process.env.LUME_LOG_LEVEL ?? "info") as LogLevel;
const MIN_LEVEL = configuredLevel in LEVEL_ORDER ? configuredLevel : "info";

let batchWriter: LogBatchNotificationWriter | null = null;
let queue: LumeLogEventInput[] = [];
let queueBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: { batch: LumeLogBatch; attempts: number; timeout: ReturnType<typeof setTimeout> } | null = null;
let droppedCount = 0;
let droppedLevels = new Set<LogLevel>();
let droppedFirstAt = "";
let droppedLastAt = "";

function truncateString(value: string): string {
  return value.length > MAX_STRING_CHARS
    ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated]`
    : value;
}

function normalizeValue(
  input: unknown,
  depth = 0,
  state: { seen: WeakSet<object>; keys: number } = { seen: new WeakSet<object>(), keys: 0 },
): unknown {
  if (input == null || typeof input === "boolean" || typeof input === "number") return input;
  if (typeof input === "string") return truncateString(input);
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "function" || typeof input === "symbol") return `[${typeof input}]`;
  if (input instanceof Error) {
    return {
      name: truncateString(input.name),
      message: truncateString(input.message),
      ...(input.stack ? { stack: truncateString(input.stack) } : {}),
    };
  }
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  if (!input || typeof input !== "object") return truncateString(String(input));
  if (state.seen.has(input)) return "[Circular]";
  state.seen.add(input);
  if (Array.isArray(input)) {
    return input.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeValue(item, depth + 1, state));
  }
  const output: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Object.keys(descriptors).slice(0, MAX_KEYS)) {
    state.keys += 1;
    if (state.keys > MAX_KEYS) break;
    const classified = classifyLogKey(key);
    if (classified === "redact") {
      output[key] = "[redacted]";
      continue;
    }
    const descriptor = descriptors[key];
    const resolved = descriptor && "value" in descriptor
      ? normalizeValue(descriptor.value, depth + 1, state)
      : "[Accessor]";
    output[key] = classified === "preview" && typeof resolved === "string"
      ? clipLogPreview(resolved)
      : resolved;
  }
  return output;
}

export function redactDiagnosticLogData(input: unknown): unknown {
  return normalizeValue(input);
}

export function createDiagnosticLogSummary(input: unknown, maxChars = 500): string {
  const redacted = redactDiagnosticLogData(input);
  let text: string;
  try {
    text = typeof redacted === "string" ? redacted : JSON.stringify(redacted ?? {});
  } catch {
    text = String(redacted);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...(truncated)`;
}

function isCredentialLikePathSegment(segment: string, previousSegment: string | undefined): boolean {
  if (/^(token|key|secret|password|webhook|auth)$/i.test(previousSegment ?? "")) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(segment)) return true;
  if (segment.length < 24) return false;
  return /[A-Za-z]/.test(segment) && /\d/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment);
}

export function sanitizeBaseUrlForLog(input: unknown): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const segments = url.pathname.split("/");
    url.pathname = segments.map((segment, index) => (
      isCredentialLikePathSegment(segment, segments[index - 1]) ? "[redacted]" : segment
    )).join("/");
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return MAX_BATCH_BYTES + 1;
  }
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function isProtected(event: LumeLogEventInput): boolean {
  return LEVEL_ORDER[event.level] >= LEVEL_ORDER.warn
    || event.event === "agent.run.completed"
    || event.event === "agent.run.failed"
    || event.event === "provider.request.completed"
    || event.event === "provider.request.failed"
    || event.event === "assistant.persisted";
}

function noteDropped(event: LumeLogEventInput): void {
  droppedCount += 1;
  droppedLevels.add(event.level);
  droppedFirstAt ||= event.emittedAt ?? new Date().toISOString();
  droppedLastAt = event.emittedAt ?? new Date().toISOString();
}

function enqueue(event: LumeLogEventInput): void {
  const eventBytes = byteLength(event);
  while (queue.length > 0 && (queue.length >= MAX_QUEUE_EVENTS || queueBytes + eventBytes > MAX_QUEUE_BYTES)) {
    const removable = queue.findIndex((candidate) => !isProtected(candidate));
    if (removable < 0) break;
    const [removed] = queue.splice(removable, 1);
    if (!removed) break;
    queueBytes -= byteLength(removed);
    noteDropped(removed);
  }
  if (queue.length >= MAX_QUEUE_EVENTS || queueBytes + eventBytes > MAX_QUEUE_BYTES) {
    if (!isProtected(event)) {
      noteDropped(event);
      return;
    }
    writeEmergencyLog("critical sidecar log queue saturated", { event: event.event });
    return;
  }
  queue.push(event);
  queueBytes += eventBytes;
  if (queue.length >= MAX_BATCH_EVENTS) trySendBatch();
  else scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer || inFlight) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    trySendBatch();
  }, FLUSH_INTERVAL_MS);
}

function createBatch(): LumeLogBatch | null {
  if (queue.length === 0) return null;
  const events: LumeLogEventInput[] = [];
  let size = 0;
  while (queue.length > 0 && events.length < MAX_BATCH_EVENTS) {
    const candidate = queue[0];
    if (!candidate) break;
    const candidateSize = byteLength(candidate);
    if (events.length > 0 && size + candidateSize > MAX_BATCH_BYTES) break;
    queue.shift();
    queueBytes -= candidateSize;
    events.push(candidate);
    size += candidateSize;
  }
  const batch: LumeLogBatch = {
    schemaVersion: LUME_LOG_SCHEMA_VERSION,
    batchId: randomUUID(),
    source: "sidecar",
    events,
  };
  if (droppedCount > 0) {
    batch.dropped = {
      count: droppedCount,
      levels: [...droppedLevels],
      firstAt: droppedFirstAt,
      lastAt: droppedLastAt,
    };
    droppedCount = 0;
    droppedLevels.clear();
    droppedFirstAt = "";
    droppedLastAt = "";
  }
  return batch;
}

function armAckTimeout(batch: LumeLogBatch, attempts: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (!inFlight || inFlight.batch.batchId !== batch.batchId) return;
    if (attempts < 2 && batchWriter) {
      try {
        batchWriter(batch);
        clearTimeout(inFlight.timeout);
        inFlight = { batch, attempts: attempts + 1, timeout: armAckTimeout(batch, attempts + 1) };
        return;
      } catch {
        // Fall through to bounded failure handling.
      }
    }
    inFlight = null;
    for (const event of batch.events) noteDropped(event);
    writeEmergencyLog("sidecar log batch acknowledgement timed out", { batchId: batch.batchId });
    scheduleFlush();
  }, ACK_TIMEOUT_MS);
}

// batchWriter 回调不得同步调用 acknowledgeLogBatch——inFlight 尚未赋值会导致 ack 早退、
// stale inFlight 阻塞后续 flush；生产 ack 经 RPC 异步到达不受影响。
function trySendBatch(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!batchWriter || inFlight) return;
  const batch = createBatch();
  if (!batch) return;
  try {
    batchWriter(batch);
    inFlight = { batch, attempts: 1, timeout: armAckTimeout(batch, 1) };
  } catch (error) {
    for (const event of batch.events.reverse()) {
      queue.unshift(event);
      queueBytes += byteLength(event);
    }
    writeEmergencyLog("sidecar log transport failed", error);
  }
}

export function setLogBatchNotificationWriter(writer: LogBatchNotificationWriter | null): void {
  batchWriter = writer;
  if (writer) trySendBatch();
}

export function acknowledgeLogBatch(batchId: string): void {
  if (!inFlight || inFlight.batch.batchId !== batchId) return;
  clearTimeout(inFlight.timeout);
  inFlight = null;
  trySendBatch();
}

export function flushLogTransport(): void {
  if (!batchWriter || inFlight) return;
  trySendBatch();
}

export function writeEmergencyLog(message: string, error?: unknown): void {
  const detail = error == null
    ? ""
    : ` ${createDiagnosticLogSummary(error, 1_000)}`;
  try { stderr.write(`${new Date().toISOString()} ERROR sidecar.emergency ${message}${detail}\n`); } catch { /* noop */ }
}

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  child(bindings: { context?: string; sessionId?: string }): Logger;
}

function emit(
  level: LogLevel,
  context: string,
  message: string,
  data?: Record<string, unknown>,
  runId?: string,
  options?: LumeLogCorrelation & {
    event?: string;
    kind?: "log" | "trace";
    status?: LumeLogStatus;
    durationMs?: number;
    rpcRequestId?: string;
    traceId?: string;
    error?: LumeLogError;
  },
): void {
  if (!shouldEmit(level) && options?.kind !== "trace") return;
  const normalizedData = normalizeValue(data ?? {}) as Record<string, unknown>;
  enqueue({
    schemaVersion: LUME_LOG_SCHEMA_VERSION,
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    level,
    source: "sidecar",
    kind: options?.kind ?? "log",
    context,
    event: options?.event ?? "log.message",
    message: truncateString(message),
    ...((options?.runId ?? runId) ? { runId: options?.runId ?? runId } : {}),
    ...(options?.status ? { status: options.status } : {}),
    ...(options?.durationMs != null ? { durationMs: options.durationMs } : {}),
    ...(options?.rpcRequestId ? { rpcRequestId: options.rpcRequestId } : {}),
    ...(options?.traceId ? { traceId: options.traceId } : {}),
    ...(options?.spanId ? { spanId: options.spanId } : {}),
    ...(options?.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
    ...(options?.parentTraceId ? { parentTraceId: options.parentTraceId } : {}),
    ...(options?.threadId ? { threadId: options.threadId } : {}),
    ...(options?.messageId ? { messageId: options.messageId } : {}),
    ...(options?.submissionId ? { submissionId: options.submissionId } : {}),
    ...(options?.providerAttemptId ? { providerAttemptId: options.providerAttemptId } : {}),
    ...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
    ...(options?.subagentRunId ? { subagentRunId: options.subagentRunId } : {}),
    ...(options?.origin ? { origin: options.origin } : {}),
    ...(options?.error ? { error: normalizeValue(options.error) as LumeLogError } : {}),
    ...(Object.keys(normalizedData).length > 0 ? { data: normalizedData } : {}),
  });
}

export function createLogger(context: string, sessionId?: string): Logger {
  const write = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    emit(level, context, msg, data, sessionId);
  };
  return {
    trace: (msg, data) => write("trace", msg, data),
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
    fatal: (msg, data) => write("fatal", msg, data),
    child: (bindings) => createLogger(bindings.context ?? context, bindings.sessionId ?? sessionId),
  };
}

export function writeLogRecord(input: {
  level: LogLevel;
  context: string;
  message: string;
  event?: string;
  kind?: "log" | "trace";
  status?: LumeLogStatus;
  durationMs?: number;
  data?: Record<string, unknown>;
  sessionId?: string;
  rpcRequestId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  parentTraceId?: string;
  threadId?: string;
  messageId?: string;
  submissionId?: string;
  providerAttemptId?: string;
  toolCallId?: string;
  subagentRunId?: string;
  origin?: string;
  runId?: string;
  error?: LumeLogError;
}): void {
  emit(input.level, input.context, input.message, input.data, input.sessionId, input);
}

export const logger = createLogger("app");

export function getLogsDir(): string {
  const configDir = process.env.LUME_CONFIG_DIR?.trim()
    || (process.env.HOME ? join(process.env.HOME, ".lume") : join(tmpdir(), "lume"));
  return join(configDir, "logs");
}

export function getCurrentLogFileName(date = new Date()): string {
  return `lume-${date.toISOString().slice(0, 10)}.ndjson`;
}

export function getCurrentLogPath(): string {
  return join(getLogsDir(), getCurrentLogFileName());
}

/** @deprecated The Electron main process is now the only ordinary log file writer. */
export function shouldWriteLogFile(): boolean {
  return false;
}
