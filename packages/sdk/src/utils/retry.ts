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
  if (err?.status === 400) {
    const message = err?.error?.error?.message || err?.message || ''
    return message.includes('prompt is too long') ||
      message.includes('max_tokens') ||
      message.includes('context length')
  }
  return false
}
