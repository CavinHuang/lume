/**
 * Webview logger client.
 *
 * Writes logs to the unified lume-logger via desktop IPC.
 * Fire-and-forget by design — log failures are swallowed since
 * this is diagnostic-only.
 */

import { LUME_LOG_SCHEMA_VERSION, normalizeLogValue, type LumeLogBatch, type LumeLogEventInput , asRecord } from '@lume/shared'
import { invoke } from '@/lib/desktop-runtime/core'

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const MAX_BATCH_EVENTS = 100
const MAX_QUEUE_EVENTS = 500
// 与 sidecar 队列门对称（sidecar 1000 条 / 512KB 双门）。
const MAX_QUEUE_BYTES = 512 * 1024
const FLUSH_INTERVAL_MS = 50

const textEncoder = new TextEncoder()

function byteLength(value: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(value)).length
  } catch {
    return MAX_QUEUE_BYTES + 1
  }
}

let queue: LumeLogEventInput[] = []
let queueBytes = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let inFlight = false


function scheduleFlush(): void {
  if (flushTimer || inFlight) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_INTERVAL_MS)
}

async function flush(): Promise<void> {
  if (inFlight || queue.length === 0) return
  inFlight = true
  const events = queue.splice(0, MAX_BATCH_EVENTS)
  let batchBytes = 0
  for (const event of events) batchBytes += byteLength(event)
  queueBytes -= batchBytes
  const batch: LumeLogBatch = {
    schemaVersion: LUME_LOG_SCHEMA_VERSION,
    batchId: crypto.randomUUID(),
    source: 'renderer',
    events,
  }
  try {
    await invoke('write_web_log_batch', batch)
  } catch {
    // 回灌到队首（保序），体积账随 batchBytes 还原；上限由下次入队的驱逐兜底。
    // Renderer diagnostics must never block or recursively log application work.
    queue.unshift(...events)
    queueBytes += batchBytes
  } finally {
    inFlight = false
    if (queue.length > 0) scheduleFlush()
  }
}

export function writeWebLog(
  level: LogLevel,
  context: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  writeWebLogEvent({
    level,
    kind: 'log',
    context,
    event: 'log.message',
    message,
    ...(data ? { data } : {}),
  })
}

/** Test-only observation point for the internal fire-and-forget queue. */
export function readRendererQueueForTest(): readonly LumeLogEventInput[] {
  return queue
}

/** Test-only: drop all queued events so tests start from an empty queue. */
export function clearRendererQueueForTest(): void {
  queue = []
  queueBytes = 0
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

export function writeWebLogEvent(
  input: Omit<LumeLogEventInput, 'schemaVersion' | 'eventId' | 'emittedAt' | 'source'>,
): void {
  const event: LumeLogEventInput = {
    schemaVersion: LUME_LOG_SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    emittedAt: new Date().toISOString(),
    source: 'renderer',
    ...input,
    ...(input.data ? { data: asRecord(normalizeLogValue(input.data)) } : {}),
  }
  const eventBytes = byteLength(event)
  while (
    queue.length > 0 &&
    (queue.length >= MAX_QUEUE_EVENTS || queueBytes + eventBytes > MAX_QUEUE_BYTES)
  ) {
    const removable = queue.findIndex((candidate) => candidate.level === 'trace' || candidate.level === 'debug')
    if (removable < 0) break
    const [removed] = queue.splice(removable, 1)
    if (removed) queueBytes -= byteLength(removed)
  }
  if (queue.length >= MAX_QUEUE_EVENTS || queueBytes + eventBytes > MAX_QUEUE_BYTES) {
    // 单事件即超字节门：入队只会永久占坑，直接弃。
    if (eventBytes > MAX_QUEUE_BYTES) return
    if (input.level !== 'warn' && input.level !== 'error' && input.level !== 'fatal') return
    const dropped = queue.shift()
    if (dropped) queueBytes -= byteLength(dropped)
  }
  queue.push(event)
  queueBytes += eventBytes
  if (queue.length >= MAX_BATCH_EVENTS) void flush()
  else scheduleFlush()
}
