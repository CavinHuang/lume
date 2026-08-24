/**
 * Unified logging details shared by all processes.
 *
 * Key classification rules:
 * - REDACT_KEY_PARTS: credential-like keys → fully "[redacted]" (substring match, never logged).
 * - CONTENT_PREVIEW_KEYS: payload-like keys → truncated preview (first N chars), so
 *   "key action params/results" stay observable without leaking full bodies.
 */

export const LOG_PREVIEW_MAX_CHARS = 200

/** Substring fragments; a key whose normalized form CONTAINS any fragment is fully redacted. */
export const REDACT_KEY_PARTS: readonly string[] = [
  'token', 'secret', 'password', 'apikey', 'authorization',
  'cookie', 'setcookie', 'accesstoken', 'refreshtoken', 'grant',
]

/** Normalized key EXACTLY in this set → truncated preview instead of full redaction. */
export const CONTENT_PREVIEW_KEYS: ReadonlySet<string> = new Set([
  'body', 'prompt', 'systemprompt', 'rawrequest', 'rawresponse', 'requestbody', 'responsebody',
  'content', 'html', 'markdown', 'input', 'output',
])

/** Union of both processes' quiet lists; failures are NEVER quiet regardless of this set. */
export const QUIET_RPC_METHODS: ReadonlySet<string> = new Set([
  'healthcheck',
  'general-settings:get',
  'agent:list-threads',
  'agent:list-subagent-runs',
  'agent:get-pending-interactive',
  'agent:list-workspaces',
  'channel:oauth-status',
  'model-meta:get',
])

export type LogKeyClass = 'redact' | 'preview' | 'keep'

export function classifyLogKey(key: string): LogKeyClass {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '')
  if (REDACT_KEY_PARTS.some((part) => normalized.includes(part))) return 'redact'
  if (CONTENT_PREVIEW_KEYS.has(normalized)) return 'preview'
  return 'keep'
}

export function clipLogPreview(text: string): string {
  return text.length > LOG_PREVIEW_MAX_CHARS
    ? `${text.slice(0, LOG_PREVIEW_MAX_CHARS)}…(+${text.length - LOG_PREVIEW_MAX_CHARS})`
    : text
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text ?? String(value)
  } catch {
    return String(value)
  }
}

const SUMMARIZE_MAX_DEPTH = 2
const SUMMARIZE_MAX_KEYS = 30

export function summarizeValue(input: unknown, depth = 0): unknown {
  if (input == null || typeof input === 'boolean' || typeof input === 'number') return input
  if (typeof input === 'string') return clipLogPreview(input)
  if (typeof input !== 'object') return `[${typeof input}]`
  if (input instanceof Error) {
    return {
      name: input.name,
      message: clipLogPreview(input.message),
      ...(input.stack ? { stack: clipLogPreview(input.stack) } : {}),
    }
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    return {
      type: input.constructor?.name ?? 'TypedArray',
      byteLength: (input as { byteLength: number }).byteLength,
    }
  }
  if (depth >= SUMMARIZE_MAX_DEPTH) return '[MaxDepth]'
  if (Array.isArray(input)) {
    return {
      length: input.length,
      items: input.slice(0, 5).map((item) => summarizeValue(item, depth + 1)),
    }
  }
  const out: Record<string, unknown> = {}
  let keyCount = 0
  for (const key in input as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    if (keyCount >= SUMMARIZE_MAX_KEYS) break
    keyCount += 1
    const value = (input as Record<string, unknown>)[key]
    const classified = classifyLogKey(key)
    if (classified === 'redact') {
      out[key] = '[redacted]'
      continue
    }
    if (classified === 'preview' && typeof value !== 'string') {
      out[key] = clipLogPreview(safeJson(value))
      continue
    }
    out[key] = summarizeValue(value, depth + 1)
  }
  return out
}
