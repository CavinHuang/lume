import { toast } from 'sonner'
import { writeWebLogEvent } from './desktop-api/logger'

/**
 * Release 构建无 DevTools：把任何未被调用方捕获的 Promise 拒绝（含 sidecar 调用失败）
 * 以 toast 形式提示出来，让原本被静默吞掉的错误可见，便于在打包版本中定位问题。
 *
 * - 过滤预期错误：用户主动中止（AbortError / 'aborted'）不提示。
 * - 去重：短时间内同一消息只提示一次，避免刷屏。
 * - 调用方已自行 try/catch 的错误不会到达这里（如 PermissionBanner 的提交错误已内联展示）。
 */
const DEDUP_WINDOW_MS = 3000
const TOAST_DURATION_MS = 8000

let installed = false
const lastShownAt = new Map<string, number>()

function isExpectedAbort(reason: unknown): boolean {
  if ((reason as { name?: string } | null)?.name === 'AbortError') return true
  return reason === 'aborted' || reason === 'ABORTED'
}

function extractMessage(reason: unknown): string | null {
  if (reason == null) return null
  if (reason instanceof Error) return reason.message || null
  if (typeof reason === 'string') return reason.length > 0 ? reason : null
  if (typeof reason === 'object' && 'message' in reason) {
    const msg = (reason as { message: unknown }).message
    if (typeof msg === 'string' && msg.length > 0) return msg
  }
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

/**
 * 纯函数：给定未处理拒绝的 reason，返回应提示的消息；返回 null 表示应跳过（中止/空）。
 * 抽出纯逻辑便于单测（监听器接线在 DOM 环境外无法覆盖）。
 */
export function resolveUnhandledRejectionToast(reason: unknown): string | null {
  if (isExpectedAbort(reason)) return null
  return extractMessage(reason)
}

export function installGlobalErrorToast(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('unhandledrejection', (event) => {
    const message = resolveUnhandledRejectionToast(event.reason)
    if (!message) return
    writeWebLogEvent({
      level: 'error',
      context: 'renderer.global',
      event: 'renderer.unhandled_rejection',
      message,
      error: event.reason instanceof Error
        ? { name: event.reason.name, message: event.reason.message, stack: event.reason.stack }
        : { message },
    })
    const now = Date.now()
    const last = lastShownAt.get(message) ?? 0
    if (now - last < DEDUP_WINDOW_MS) return
    lastShownAt.set(message, now)
    toast.error(message, { duration: TOAST_DURATION_MS })
  })
  window.addEventListener('error', (event) => {
    writeWebLogEvent({
      level: 'error',
      context: 'renderer.global',
      event: 'renderer.uncaught_error',
      message: event.message || 'uncaught renderer error',
      error: event.error instanceof Error
        ? { name: event.error.name, message: event.error.message, stack: event.error.stack }
        : { message: event.message || 'uncaught renderer error' },
      data: { filename: event.filename, line: event.lineno, column: event.colno },
    })
  })
}
