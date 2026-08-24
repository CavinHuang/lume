/**
 * Bridges console.error/warn into the unified log pipeline.
 * Release builds have no DevTools — without this, those diagnostics are lost.
 * Fixed-window rate limit keeps floods from saturating the transport.
 */
import { writeWebLogEvent } from '@/lib/desktop-api/logger'

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 30

let windowStart = 0
let sentInWindow = 0
let droppedInWindow = 0
let installed = false
let restoreError: (() => void) | null = null
let restoreWarn: (() => void) | null = null

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function forward(level: 'error' | 'warn', args: unknown[]): void {
  const now = Date.now()
  if (now - windowStart >= WINDOW_MS) {
    if (droppedInWindow > 0) {
      writeWebLogEvent({
        level: 'warn',
        kind: 'log',
        context: 'console.bridge',
        event: 'console.dropped',
        message: `dropped ${droppedInWindow} console messages in previous window`,
        data: { dropped: droppedInWindow },
      })
      droppedInWindow = 0
    }
    windowStart = now
    sentInWindow = 0
  }
  if (sentInWindow >= MAX_PER_WINDOW) {
    droppedInWindow += 1
    return
  }
  sentInWindow += 1
  const firstError = args.find((arg): arg is Error => arg instanceof Error)
  writeWebLogEvent({
    level,
    kind: 'log',
    context: 'console',
    event: level === 'error' ? 'console.error' : 'console.warn',
    message: args.map(formatValue).join(' ').slice(0, 2_000),
    ...(firstError?.stack ? { data: { stack: firstError.stack } } : {}),
  })
}

export function installConsoleBridge(): void {
  if (installed) return
  installed = true
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    const wrapped = (...args: unknown[]) => {
      try {
        forward(level, args)
      } catch {
        // Bridge failures must never alter caller behavior.
      }
      original(...args)
    }
    console[level] = wrapped
    if (level === 'error') restoreError = () => { console.error = original }
    else restoreWarn = () => { console.warn = original }
  }
}

export function resetConsoleBridgeForTest(): void {
  restoreError?.()
  restoreWarn?.()
  restoreError = null
  restoreWarn = null
  installed = false
  windowStart = 0
  sentInWindow = 0
  droppedInWindow = 0
}
