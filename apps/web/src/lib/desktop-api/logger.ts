/**
 * Webview logger client.
 *
 * Writes logs to the unified lume-logger via desktop IPC.
 * Fire-and-forget by design — log failures are swallowed since
 * this is diagnostic-only.
 */

import { LUME_LOG_SCHEMA_VERSION, type LumeLogBatch, type LumeLogEventInput } from '@lume/shared'
import { invoke } from '@/lib/desktop-runtime/core'

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const MAX_BATCH_EVENTS = 100
const MAX_QUEUE_EVENTS = 500
const FLUSH_INTERVAL_MS = 50

let queue: LumeLogEventInput[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let inFlight = false

function normalizeValue(
  input: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (input == null || typeof input === 'boolean' || typeof input === 'number') return input
  if (typeof input === 'string') return input.length > 8_192 ? `${input.slice(0, 8_192)}…[truncated]` : input
  if (typeof input === 'bigint') return input.toString()
  if (typeof input === 'function' || typeof input === 'symbol') return `[${typeof input}]`
  if (input instanceof Error) return { name: input.name, message: input.message, stack: input.stack }
  if (depth >= 6) return '[MaxDepth]'
  if (!input || typeof input !== 'object') return String(input)
  if (seen.has(input)) return '[Circular]'
  seen.add(input)
  if (Array.isArray(input)) return input.slice(0, 100).map((item) => normalizeValue(item, depth + 1, seen))
  const output: Record<string, unknown> = {}
  const descriptors = Object.getOwnPropertyDescriptors(input)
  for (const key of Object.keys(descriptors).slice(0, 100)) {
    const normalizedKey = key.toLowerCase().replace(/[-_\s]/g, '')
    if (
      ['body', 'prompt', 'systemprompt', 'rawrequest', 'rawresponse', 'requestbody', 'responsebody', 'content', 'html', 'markdown', 'input', 'output'].includes(normalizedKey)
      || ['token', 'secret', 'password', 'apikey', 'authorization', 'cookie'].some((part) => normalizedKey.includes(part))
    ) {
      output[key] = '[redacted]'
      continue
    }
    const descriptor = descriptors[key]
    output[key] = descriptor && 'value' in descriptor
      ? normalizeValue(descriptor.value, depth + 1, seen)
      : '[Accessor]'
  }
  return output
}

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
  const batch: LumeLogBatch = {
    schemaVersion: LUME_LOG_SCHEMA_VERSION,
    batchId: crypto.randomUUID(),
    source: 'renderer',
    events,
  }
  try {
    await invoke('write_web_log_batch', batch)
  } catch {
    // Renderer diagnostics must never block or recursively log application work.
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

export function writeWebLogEvent(
  input: Omit<LumeLogEventInput, 'schemaVersion' | 'eventId' | 'emittedAt' | 'source'>,
): void {
  const event: LumeLogEventInput = {
    schemaVersion: LUME_LOG_SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    emittedAt: new Date().toISOString(),
    source: 'renderer',
    ...input,
    ...(input.data ? { data: normalizeValue(input.data) as Record<string, unknown> } : {}),
  }
  if (queue.length >= MAX_QUEUE_EVENTS) {
    const removable = queue.findIndex((candidate) => candidate.level === 'trace' || candidate.level === 'debug')
    if (removable >= 0) queue.splice(removable, 1)
    else if (input.level !== 'warn' && input.level !== 'error' && input.level !== 'fatal') return
    else queue.shift()
  }
  queue.push(event)
  if (queue.length >= MAX_BATCH_EVENTS) void flush()
  else scheduleFlush()
}
