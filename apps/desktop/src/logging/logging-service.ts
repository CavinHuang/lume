import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  ElectronLogEvent,
  LogFileListResult,
  LogLineEntry,
  ExportLogsResult,
  ReadLogFileInput,
  ReadLogFileResult,
} from '@lume/shared'
import type {
  LumeLogBatch,
  LumeLogEventInput,
  LumeLogEventV2,
  LumeLogLevel,
  LumeLogSource,
  LumeLoggingSettings,
} from '@lume/shared'
import { LUME_LOGGING_DEFAULTS, LUME_LOG_SCHEMA_VERSION, classifyLogKey, clipLogPreview } from '@lume/shared'

const LEVEL_ORDER: Record<LumeLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

const MAX_BATCH_EVENTS = 100
const MAX_BATCH_BYTES = 512 * 1024
const MAX_QUEUE_EVENTS = 5_000
const MAX_RECENT_EVENT_IDS = 10_000
const FLUSH_INTERVAL_MS = 50
const MAX_DATA_DEPTH = 6
const MAX_DATA_KEYS = 100
const MAX_ARRAY_ITEMS = 100
const MAX_STRING_CHARS = 8_192
const MAX_EVENT_BYTES = 64 * 1024

const LOG_FILE_PATTERN = /^[a-zA-Z0-9._-]+\.(?:log|ndjson)(?:\.\d+)?$/
const PINO_LEVELS: Record<number, LumeLogLevel> = {
  10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
}
const TRACE_SPINE_EVENTS = new Set([
  'message.submitted',
  'message.accepted',
  'agent.run.started',
  'agent.run.completed',
  'agent.run.failed',
  'provider.request.completed',
  'provider.request.failed',
  'assistant.persisted',
  'reply.committed',
  'reply.delivery_unknown',
  'trace.linked',
  'trace.incomplete',
])
const TERMINAL_INFO_EVENTS = new Set([
  'app.started',
  'app.ready',
  'app.stopping',
  'sidecar.starting',
  'sidecar.started',
  'sidecar.ready',
  'sidecar.stopped',
  'logging.started',
])

type LiveListener = (events: LumeLogEventV2[]) => void

export interface LoggingServiceOptions {
  configDir: string
  settings?: Partial<LumeLoggingSettings>
  terminal?: Pick<NodeJS.WriteStream, 'write'>
  now?: () => Date
}

interface NormalizeState {
  seen: WeakSet<object>
  keys: number
}

function normalizeString(value: string): string {
  return value.length > MAX_STRING_CHARS
    ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated]`
    : value
}

export function normalizeLogValue(
  value: unknown,
  depth = 0,
  state: NormalizeState = { seen: new WeakSet<object>(), keys: 0 },
): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return normalizeString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}]`
  if (value instanceof Error) {
    return {
      name: normalizeString(value.name),
      message: normalizeString(value.message),
      ...(value.stack ? { stack: normalizeString(value.stack) } : {}),
    }
  }
  if (depth >= MAX_DATA_DEPTH) return '[MaxDepth]'
  if (!value || typeof value !== 'object') return normalizeString(String(value))
  if (state.seen.has(value)) return '[Circular]'
  state.seen.add(value)

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeLogValue(item, depth + 1, state))
  }

  const output: Record<string, unknown> = {}
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Object.keys(descriptors).slice(0, MAX_DATA_KEYS)) {
    state.keys += 1
    if (state.keys > MAX_DATA_KEYS) break
    const classified = classifyLogKey(key)
    if (classified === 'redact') {
      output[key] = '[redacted]'
      continue
    }
    const descriptor = descriptors[key]
    const resolved = descriptor && 'value' in descriptor
      ? normalizeLogValue(descriptor.value, depth + 1, state)
      : '[Accessor]'
    output[key] = classified === 'preview' && typeof resolved === 'string'
      ? clipLogPreview(resolved)
      : resolved
  }
  return output
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined
  const normalized = normalizeLogValue(value)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return { value: normalized }
  }
  return normalized as Record<string, unknown>
}

function normalizeError(value: unknown): LumeLogEventV2['error'] | undefined {
  if (!value) return undefined
  const normalized = safeRecord(value)
  if (!normalized) return undefined
  const message = typeof normalized.message === 'string' ? normalized.message : 'Unknown error'
  return {
    message,
    ...(typeof normalized.name === 'string' ? { name: normalized.name } : {}),
    ...(typeof normalized.code === 'string' ? { code: normalized.code } : {}),
    ...(typeof normalized.category === 'string' ? { category: normalized.category } : {}),
    ...(typeof normalized.stack === 'string' ? { stack: normalized.stack } : {}),
    ...(typeof normalized.retryable === 'boolean' ? { retryable: normalized.retryable } : {}),
  }
}

function isLevel(value: unknown): value is LumeLogLevel {
  return typeof value === 'string' && value in LEVEL_ORDER
}

function isSource(value: unknown): value is LumeLogSource {
  return value === 'main'
    || value === 'sidecar'
    || value === 'renderer'
    || value === 'desktop-host'
    || value === 'node-repl'
}

function validName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().slice(0, 128)
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed) ? trimmed : fallback
}

function validId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(trimmed) ? trimmed : undefined
}

function toIso(value: unknown, fallback: Date): string {
  if (typeof value === 'string') {
    const date = new Date(value)
    if (Number.isFinite(date.getTime())) return date.toISOString()
  }
  return fallback.toISOString()
}

function encodedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return MAX_EVENT_BYTES + 1
  }
}

function shortId(value: string | undefined): string | undefined {
  return value ? value.slice(0, 8) : undefined
}

export class LoggingService {
  readonly logsDir: string

  private readonly now: () => Date
  private readonly terminal: Pick<NodeJS.WriteStream, 'write'>
  private settings: LumeLoggingSettings
  private seq = 0
  private queue: LumeLogEventV2[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> | null = null
  private activeDate = ''
  private activeSuffix = 0
  private activePath = ''
  private activeSize = 0
  private recentEventIds = new Set<string>()
  private droppedCount = 0
  private droppedLevels = new Set<LumeLogLevel>()
  private droppedFirstAt = ''
  private droppedLastAt = ''
  private listeners = new Set<LiveListener>()
  private snapshotActive = false

  constructor(options: LoggingServiceOptions) {
    this.logsDir = join(options.configDir, 'logs')
    this.settings = { ...LUME_LOGGING_DEFAULTS, ...options.settings }
    const legacyLevel = process.env.LUME_LOG_LEVEL
    if (isLevel(legacyLevel)) {
      if (!process.env.LUME_LOG_CONSOLE_LEVEL) this.settings.consoleLevel = legacyLevel
      if (!process.env.LUME_LOG_FILE_LEVEL) this.settings.fileLevel = legacyLevel
    }
    this.terminal = options.terminal ?? process.stderr
    this.now = options.now ?? (() => new Date())
    void mkdir(this.logsDir, { recursive: true })
      .then(() => this.cleanup())
      .catch((error) => this.writeEmergency('logging initialization failed', error))
    if (process.env.LUME_LOG_LEVEL || process.env.LUME_LOG_CONSOLE || process.env.LUME_LOG_FILE) {
      queueMicrotask(() => this.emit({
        level: 'warn',
        source: 'main',
        context: 'logging.config',
        event: 'logging.legacy_env_deprecated',
        message: 'legacy LUME_LOG_* environment variables are deprecated',
        data: { use: ['LUME_LOG_CONSOLE_LEVEL', 'LUME_LOG_FILE_LEVEL', 'LUME_LOG_FORMAT'] },
      }))
    }
  }

  updateSettings(settings: Partial<LumeLoggingSettings>): void {
    this.settings = { ...this.settings, ...settings }
  }

  subscribe(listener: LiveListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(input: LumeLogEventInput): LumeLogEventV2 | null {
    return this.accept(input, input.source)
  }

  ingestBatch(batch: LumeLogBatch, expectedSource: Exclude<LumeLogSource, 'main'>): number {
    if (!batch || batch.schemaVersion !== LUME_LOG_SCHEMA_VERSION || batch.source !== expectedSource) {
      throw new Error('invalid log batch source or schema')
    }
    if (!Array.isArray(batch.events) || batch.events.length > MAX_BATCH_EVENTS) {
      throw new Error('invalid log batch size')
    }
    if (encodedSize(batch) > MAX_BATCH_BYTES) throw new Error('log batch exceeds byte limit')

    let accepted = 0
    for (const input of batch.events) {
      if (input.source !== expectedSource) continue
      if (this.accept(input, expectedSource)) accepted += 1
    }
    if (batch.dropped?.count && batch.dropped.count > 0) {
      this.accept({
        level: 'warn',
        kind: 'log',
        source: expectedSource,
        context: 'logging.transport',
        event: 'logging.events_dropped',
        message: `${expectedSource} dropped ${batch.dropped.count} log events before transport`,
        data: batch.dropped,
      }, expectedSource)
    }
    return accepted
  }

  ingestLegacy(input: ElectronLogEvent, source: LumeLogSource): LumeLogEventV2 | null {
    return this.accept({
      emittedAt: input.timestamp ?? input.ts,
      level: isLevel(input.level) ? input.level : 'info',
      source,
      context: validName(input.context, 'legacy'),
      event: 'legacy.log',
      message: typeof input.message === 'string' ? input.message : '',
      data: safeRecord(input.data),
      ...(input.sessionId ? { runId: input.sessionId } : {}),
    }, source)
  }

  async flush(): Promise<void> {
    if (this.snapshotActive) {
      return
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushPromise) return this.flushPromise
    this.flushPromise = this.flushInternal().finally(() => {
      this.flushPromise = null
      if (this.queue.length > 0) this.scheduleFlush()
    })
    return this.flushPromise
  }

  async close(): Promise<void> {
    await this.flush()
  }

  async listFiles(): Promise<LogFileListResult> {
    await mkdir(this.logsDir, { recursive: true })
    const names = (await readdir(this.logsDir)).filter((name) => LOG_FILE_PATTERN.test(name))
    const files = await Promise.all(names.map(async (name) => {
      const info = await stat(join(this.logsDir, name))
      return { name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() }
    }))
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.name.localeCompare(a.name))
    return {
      directory: '',
      files,
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    }
  }

  async readFile(input: ReadLogFileInput): Promise<ReadLogFileResult> {
    if (!LOG_FILE_PATTERN.test(input.fileName)) throw new Error('invalid log file name')
    const content = await readFile(join(this.logsDir, input.fileName), 'utf8')
    const rawLines = content.split(/\r?\n/).filter(Boolean)
    const requestedLevels = input.levels?.length ? new Set(input.levels) : null
    const query = input.query?.trim().toLowerCase()
    const maxLines = Math.max(1, Math.min(input.maxLines ?? 2_000, 10_000))
    const matches: LogLineEntry[] = []
    let matchedLines = 0
    for (let index = rawLines.length - 1; index >= 0; index -= 1) {
      const text = rawLines[index]
      let level: LumeLogLevel = 'info'
      let event: LumeLogEventV2 | undefined
      let source: string | undefined
      let context: string | undefined
      let eventName: string | undefined
      let kind: string | undefined
      let status: string | undefined
      let traceId: string | undefined
      let displayText = text
      try {
        const parsed = JSON.parse(text) as Partial<LumeLogEventV2> & { ts?: unknown; timestamp?: unknown; msg?: unknown }
        if (isLevel(parsed.level)) level = parsed.level
        else if (typeof parsed.level === 'number') level = PINO_LEVELS[parsed.level] ?? 'info'
        source = typeof parsed.source === 'string' ? parsed.source : undefined
        context = typeof parsed.context === 'string' ? parsed.context : undefined
        eventName = typeof parsed.event === 'string' ? parsed.event : undefined
        kind = typeof parsed.kind === 'string' ? parsed.kind : undefined
        status = typeof parsed.status === 'string' ? parsed.status : undefined
        traceId = typeof parsed.traceId === 'string' ? parsed.traceId : undefined
        const timestamp = typeof parsed.observedAt === 'string'
          ? parsed.observedAt
          : typeof parsed.timestamp === 'string' ? parsed.timestamp : typeof parsed.ts === 'string' ? parsed.ts : ''
        const message = typeof parsed.message === 'string' ? parsed.message : typeof parsed.msg === 'string' ? parsed.msg : ''
        displayText = `${timestamp} ${level.toUpperCase()} ${context ?? source ?? 'legacy'}${eventName ? ` ${eventName}` : ''} ${message}`.trim()
        if (parsed.schemaVersion === LUME_LOG_SCHEMA_VERSION && typeof parsed.eventId === 'string') {
          event = parsed as LumeLogEventV2
        }
      } catch {
        // Legacy plain text remains readable as info.
      }
      if (requestedLevels && !requestedLevels.has(level)) continue
      if (query && !text.toLowerCase().includes(query)) continue
      if (input.traceId && traceId !== input.traceId) continue
      if (input.source && source !== input.source) continue
      if (input.kind && kind !== input.kind) continue
      if (input.context && context !== input.context) continue
      if (input.event && eventName !== input.event) continue
      if (input.status && status !== input.status) continue
      matchedLines += 1
      if (matches.length >= maxLines) continue
      matches.push({
        lineNumber: index + 1,
        level,
        text: displayText,
        rawJson: text,
        ...(event ? { event } : {}),
      })
    }
    matches.reverse()
    return {
      fileName: input.fileName,
      totalLines: rawLines.length,
      matchedLines,
      lines: matches,
    }
  }

  async query(input: ReadLogFileInput): Promise<ReadLogFileResult> {
    if (input.fileName !== '*') return this.readFile(input)
    const maxLines = Math.max(1, Math.min(input.maxLines ?? 2_000, 10_000))
    const snapshot = await this.listFiles()
    let totalLines = 0
    let matchedLines = 0
    let lines: LogLineEntry[] = []
    for (const file of [...snapshot.files].reverse()) {
      const result = await this.readFile({ ...input, fileName: file.name, maxLines })
      totalLines += result.totalLines
      matchedLines += result.matchedLines
      lines.push(...result.lines.map((line) => ({ ...line, fileName: result.fileName })))
      if (lines.length > maxLines) lines = lines.slice(-maxLines)
    }
    return {
      fileName: '*',
      totalLines,
      matchedLines,
      lines,
    }
  }

  async exportAll(): Promise<ExportLogsResult> {
    await this.flush()
    this.snapshotActive = true
    try {
      const snapshot = await this.listFiles()
      const exportDir = join(this.logsDir, 'exports')
      await mkdir(exportDir, { recursive: true })
      const fileName = `lume-logs-${this.now().toISOString().replace(/[:.]/g, '-')}.txt`
      const path = join(exportDir, fileName)
      const chunks: string[] = []
      for (const file of [...snapshot.files].reverse()) {
        chunks.push(`===== ${file.name} =====`, await readFile(join(this.logsDir, file.name), 'utf8'), '')
      }
      await writeFile(path, chunks.join('\n'), 'utf8')
      const info = await stat(path)
      return { path: '', fileName, sizeBytes: info.size }
    } finally {
      this.snapshotActive = false
      if (this.queue.length > 0) this.scheduleFlush()
    }
  }

  async clear(): Promise<number> {
    await this.flush()
    this.snapshotActive = true
    try {
      const snapshot = await this.listFiles()
      await Promise.all(snapshot.files.map((file) => rm(join(this.logsDir, file.name), { force: true })))
      this.activeDate = ''
      this.activePath = ''
      this.activeSize = 0
      return snapshot.files.length
    } finally {
      this.snapshotActive = false
      if (this.queue.length > 0) this.scheduleFlush()
    }
  }

  private accept(input: LumeLogEventInput, expectedSource: LumeLogSource): LumeLogEventV2 | null {
    if (!input || input.source !== expectedSource || !isSource(input.source) || !isLevel(input.level)) return null
    const now = this.now()
    const eventId = validId(input.eventId) ?? randomUUID()
    if (this.recentEventIds.has(eventId)) return null

    const data = safeRecord(input.data)
    const normalized: LumeLogEventV2 = {
      schemaVersion: LUME_LOG_SCHEMA_VERSION,
      eventId,
      emittedAt: toIso(input.emittedAt, now),
      observedAt: now.toISOString(),
      seq: ++this.seq,
      kind: input.kind === 'trace' ? 'trace' : 'log',
      level: input.level,
      source: input.source,
      context: validName(input.context, 'app'),
      event: validName(input.event, 'log.message'),
      message: normalizeString(typeof input.message === 'string' ? input.message : ''),
      ...(input.status ? { status: input.status } : {}),
      ...(Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, input.durationMs as number) } : {}),
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
      ...(input.error ? { error: normalizeError(input.error) } : {}),
      ...(input.internal ? { internal: true } : {}),
    }

    for (const key of [
      'traceId', 'spanId', 'parentSpanId', 'parentTraceId', 'runId', 'threadId', 'messageId',
      'submissionId', 'rpcRequestId', 'providerAttemptId', 'toolCallId', 'subagentRunId',
      'deliveryAttemptId', 'origin',
    ] as const) {
      const value = validId(input[key])
      if (value) normalized[key] = value
    }

    if (encodedSize(normalized) > MAX_EVENT_BYTES) {
      normalized.data = { truncated: true, originalDataOmitted: true }
      normalized.error = normalized.error
        ? { ...normalized.error, stack: undefined }
        : undefined
    }

    this.rememberEventId(eventId)
    this.writeTerminal(normalized)
    const configuredFileLevel = process.env.LUME_LOG_FILE_LEVEL
    const fileThreshold = isLevel(configuredFileLevel) ? configuredFileLevel : this.settings.fileLevel
    if (process.env.LUME_LOG_FILE !== 'false'
      && (normalized.kind === 'trace' || LEVEL_ORDER[normalized.level] >= LEVEL_ORDER[fileThreshold])) {
      this.enqueue(normalized)
    }
    return normalized
  }

  private enqueue(event: LumeLogEventV2): void {
    if (this.queue.length >= MAX_QUEUE_EVENTS) {
      const removable = this.queue.findIndex((candidate) => !this.isProtected(candidate))
      if (removable >= 0) {
        const [dropped] = this.queue.splice(removable, 1)
        this.noteDropped(dropped)
      } else if (!this.isProtected(event)) {
        this.noteDropped(event)
        return
      } else {
        this.writeEmergency('critical log queue saturated', { event: event.event, source: event.source })
        return
      }
    }
    this.queue.push(event)
    if (this.queue.length >= MAX_BATCH_EVENTS) void this.flush()
    else this.scheduleFlush()
  }

  private isProtected(event: LumeLogEventV2): boolean {
    return LEVEL_ORDER[event.level] >= LEVEL_ORDER.warn || TRACE_SPINE_EVENTS.has(event.event)
  }

  private noteDropped(event: LumeLogEventV2): void {
    this.droppedCount += 1
    this.droppedLevels.add(event.level)
    this.droppedFirstAt ||= event.observedAt
    this.droppedLastAt = event.observedAt
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushPromise) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, FLUSH_INTERVAL_MS)
  }

  private async flushInternal(): Promise<void> {
    if (this.droppedCount > 0 && this.queue.length < MAX_QUEUE_EVENTS) {
      const now = this.now()
      const dropped = this.droppedCount
      const levels = [...this.droppedLevels]
      const firstAt = this.droppedFirstAt
      const lastAt = this.droppedLastAt
      this.droppedCount = 0
      this.droppedLevels.clear()
      this.droppedFirstAt = ''
      this.droppedLastAt = ''
      this.queue.push({
        schemaVersion: LUME_LOG_SCHEMA_VERSION,
        eventId: randomUUID(),
        emittedAt: now.toISOString(),
        observedAt: now.toISOString(),
        seq: ++this.seq,
        kind: 'log',
        level: 'warn',
        source: 'main',
        context: 'logging.queue',
        event: 'logging.events_dropped',
        message: `dropped ${dropped} low-priority log events`,
        data: { count: dropped, levels, firstAt, lastAt },
      })
    }

    const events = this.queue.splice(0, MAX_BATCH_EVENTS)
    if (events.length === 0) return
    const lines = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    try {
      await mkdir(this.logsDir, { recursive: true })
      await this.ensureSegment(Buffer.byteLength(lines, 'utf8'), this.now())
      await appendFile(this.activePath, lines, 'utf8')
      this.activeSize += Buffer.byteLength(lines, 'utf8')
      for (const listener of this.listeners) {
        try { listener(events) } catch { /* subscriber failures cannot break the writer */ }
      }
    } catch (error) {
      // Put the batch back so the next flush retries it instead of silently
      // losing it; the queue cap plus enqueue drop accounting bound memory
      // if the append keeps failing.
      this.queue.unshift(...events)
      this.writeEmergency('log append failed', error)
    }
  }

  private async ensureSegment(incomingBytes: number, now: Date): Promise<void> {
    const date = now.toISOString().slice(0, 10)
    const maxBytes = Math.max(1, this.settings.maxSegmentMb) * 1024 * 1024
    if (!this.activePath || this.activeDate !== date) {
      this.activeDate = date
      this.activeSuffix = 0
      this.activePath = join(this.logsDir, `lume-${date}.ndjson`)
      this.activeSize = await stat(this.activePath).then((info) => info.size).catch(() => 0)
    }
    if (this.activeSize > 0 && this.activeSize + incomingBytes > maxBytes) {
      this.activeSuffix += 1
      this.activePath = join(this.logsDir, `lume-${date}.ndjson.${this.activeSuffix}`)
      this.activeSize = await stat(this.activePath).then((info) => info.size).catch(() => 0)
      await this.cleanup()
    }
  }

  private async cleanup(): Promise<void> {
    await mkdir(this.logsDir, { recursive: true })
    const now = this.now().getTime()
    const maxAge = Math.max(1, this.settings.retentionDays) * 24 * 60 * 60 * 1000
    const maxTotal = Math.max(1, this.settings.maxTotalMb) * 1024 * 1024
    const names = (await readdir(this.logsDir)).filter((name) => LOG_FILE_PATTERN.test(name))
    const entries = await Promise.all(names.map(async (name) => {
      const path = join(this.logsDir, name)
      const info = await stat(path)
      return { path, size: info.size, mtime: info.mtimeMs }
    }))
    entries.sort((a, b) => a.mtime - b.mtime)
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of entries) {
      if (entry.path === this.activePath) continue
      if (now - entry.mtime <= maxAge && total <= maxTotal) continue
      await rm(entry.path, { force: true }).catch(() => {})
      total -= entry.size
    }
  }

  private rememberEventId(eventId: string): void {
    this.recentEventIds.add(eventId)
    if (this.recentEventIds.size <= MAX_RECENT_EVENT_IDS) return
    const oldest = this.recentEventIds.values().next().value
    if (oldest) this.recentEventIds.delete(oldest)
  }

  private writeTerminal(event: LumeLogEventV2): void {
    if (process.env.LUME_LOG_CONSOLE === 'false') return
    const configuredLevel = process.env.LUME_LOG_CONSOLE_LEVEL
    const threshold = isLevel(configuredLevel) ? configuredLevel : this.settings.consoleLevel
    const explicitVerbose = threshold === 'trace' || threshold === 'debug'
    const visible = LEVEL_ORDER[event.level] >= LEVEL_ORDER.warn
      || (event.level === 'info' && TERMINAL_INFO_EVENTS.has(event.event))
      || (explicitVerbose && LEVEL_ORDER[event.level] >= LEVEL_ORDER[threshold])
    if (!visible) return
    const ids = [
      shortId(event.traceId) ? `trace=${shortId(event.traceId)}` : '',
      shortId(event.runId) ? `run=${shortId(event.runId)}` : '',
      shortId(event.rpcRequestId) ? `rpc=${shortId(event.rpcRequestId)}` : '',
    ].filter(Boolean).join(' ')
    const format = process.env.LUME_LOG_FORMAT === 'json' ? 'json' : this.settings.format
    this.terminal.write(format === 'json'
      ? `${JSON.stringify(event)}\n`
      : `${event.observedAt} ${event.level.toUpperCase()} ${event.context} ${event.event}${ids ? ` ${ids}` : ''} ${event.message}\n`)
  }

  private writeEmergency(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    try { this.terminal.write(`${this.now().toISOString()} ERROR logging.emergency ${message}: ${detail}\n`) } catch { /* noop */ }
  }
}
