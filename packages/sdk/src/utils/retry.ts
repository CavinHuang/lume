/**
 * Retry Logic with Exponential Backoff
 *
 * Handles API retries for rate limits, overloaded servers,
 * and transient failures.
 */

/**
 * Retry configuration.
 */
export interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  retryableStatusCodes: number[]
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  retryableStatusCodes: [429, 500, 502, 503, 529],
}

/**
 * Check if an error is retryable.
 */
export function isRetryableError(err: any, config: RetryConfig = DEFAULT_RETRY_CONFIG): boolean {
  if (err?.status && config.retryableStatusCodes.includes(err.status)) {
    return true
  }

  // Network errors
  if (err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNREFUSED') {
    return true
  }

  // API overloaded
  if (err?.error?.type === 'overloaded_error') {
    return true
  }

  return false
}

/**
 * Calculate delay for exponential backoff.
 */
export function getRetryDelay(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number {
  const delay = config.baseDelayMs * Math.pow(2, attempt)
  // Add jitter (±25%)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1)
  return Math.min(delay + jitter, config.maxDelayMs)
}

/**
 * Hard cap for server-provided Retry-After delays (#351).
 */
export const MAX_RETRY_AFTER_DELAY_MS = 120_000

/**
 * Parse a Retry-After header value (delta-seconds or HTTP-date) into
 * milliseconds. Returns undefined when the value is absent or unparseable (#351).
 */
export function parseRetryAfterHeader(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000
  const dateMs = Date.parse(value)
  if (Number.isNaN(dateMs)) return undefined
  return Math.max(dateMs - Date.now(), 0)
}

/**
 * Delay before the next retry attempt: the server-provided Retry-After hint
 * when present (clamped to a hard cap), exponential backoff otherwise (#351).
 */
export function computeRetryDelay(
  err: unknown,
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): number {
  const retryAfterMs = (err as { retryAfterMs?: unknown })?.retryAfterMs
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) {
    return Math.min(Math.max(retryAfterMs, 0), MAX_RETRY_AFTER_DELAY_MS)
  }
  return getRetryDelay(attempt, config)
}

/**
 * Execute a function with retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  abortSignal?: AbortSignal,
  onRetry?: (info: { attempt: number; maxRetries: number; retryDelayMs: number; error: any }) => void | Promise<void>,
): Promise<T> {
  let lastError: any

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (abortSignal?.aborted) {
      throw new Error('Aborted')
    }

    try {
      return await fn()
    } catch (err: any) {
      lastError = err

      if (!isRetryableError(err, config)) {
        throw err
      }

      if (attempt === config.maxRetries) {
        throw err
      }

      // Wait before retry
      const delay = computeRetryDelay(err, attempt, config)
      await onRetry?.({
        attempt: attempt + 1,
        maxRetries: config.maxRetries,
        retryDelayMs: delay,
        error: err,
      })
      // Backoff must stay abortable: a fixed sleep would pin the caller for
      // up to maxDelayMs (30s) after the user cancels (#231).
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer)
          reject(new Error('Aborted'))
        }
        const timer = setTimeout(() => {
          abortSignal?.removeEventListener('abort', onAbort)
          resolve()
        }, delay)
        if (abortSignal) {
          if (abortSignal.aborted) {
            onAbort()
            return
          }
          abortSignal.addEventListener('abort', onAbort, { once: true })
        }
      })
    }
  }

  throw lastError
}

/**
 * Check if an error is a "prompt too long" error.
 */
export function isPromptTooLongError(err: any): boolean {
  const message = String(err?.error?.error?.message || err?.error?.message || err?.message || '')
  // An HTML body means a gateway/proxy error page, not a provider API error:
  // it carries no token semantics and recovery would just burn three summary
  // calls before the breaker trips (#709 item 3). It vetoes both the 413 fast
  // path and the message regex; a structured context_length_exceeded code on a
  // 400 still wins over an incidental <html> fragment in the message text.
  const hasHtmlBody = /<html/i.test(message)
  if (err?.status === 413) return !hasHtmlBody
  // TGI's router answers ValidationError with HTTP 422 (unlike OpenAI-compat
  // gateways that normalize to 400) — without it the TGI wordings below are
  // unreachable against a direct self-hosted endpoint (#725 review S3).
  if (err?.status !== 400 && err?.status !== 422) return false
  const code = String(err?.error?.error?.code || err?.error?.code || '')
  if (code.includes('context_length_exceeded')) return true
  return !hasHtmlBody && /context[ _-]?length|maximum context|prompt( is|'s)? too (long|large)|input (is )?too long|request.{0,16}too large|exceeds the maximum number of tokens|must have less than \d+ tokens|input token count|max_new_tokens.{0,3}must be/i.test(message)
}
