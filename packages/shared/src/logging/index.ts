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
  'content', 'contents', 'html', 'markdown', 'input', 'output',
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

const SUMMARIZE_MAX_DEPTH = 2
const SUMMARIZE_MAX_KEYS = 30

/** 关联 ID 键 → 事件顶层字段名；值须通过 validId 同款形状校验才采纳。 */
const CORRELATION_ID_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['traceId', 'traceId'],
  ['runId', 'runId'],
  ['threadId', 'threadId'],
  ['sessionId', 'threadId'],
  ['submissionId', 'submissionId'],
  ['messageId', 'messageId'],
  ['rpcRequestId', 'rpcRequestId'],
]

function isValidIdShape(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)
}

/**
 * 从载荷浅层（顶层与一层嵌套）提取已知关联 ID，供 IPC/RPC 摘要事件挂到顶层，
 * 使工程师能从一条 command.completed 结构化跳转到同会话的 agent spine。
 */
export function extractCorrelationIds(payload: unknown, depth = 0): Record<string, string> {
  const out: Record<string, string> = {}
  if (depth > 1 || payload == null || typeof payload !== 'object' || Array.isArray(payload)) return out
  for (const [key, field] of CORRELATION_ID_KEYS) {
    if (out[field]) continue
    const candidate = (payload as Record<string, unknown>)[key]
    if (isValidIdShape(candidate)) out[field] = candidate
  }
  if (depth === 0) {
    for (const child of Object.values(payload as Record<string, unknown>)) {
      const nested = extractCorrelationIds(child, 1)
      for (const [field, value] of Object.entries(nested)) {
        if (!out[field]) out[field] = value
      }
    }
  }
  return out
}

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
    // 内容键的对象值必须走递归分类：任何在此处直接 JSON 序列化的捷径都会让嵌套凭据绕过脱敏。
    out[key] = summarizeValue(value, depth + 1)
  }
  return out
}
