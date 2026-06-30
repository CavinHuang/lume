/**
 * Webview logger client.
 *
 * Writes logs to the unified lume-logger via desktop IPC.
 * Fire-and-forget by design — log failures are swallowed since
 * this is diagnostic-only.
 */

import { invoke } from '@/lib/desktop-runtime/core'

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export function writeWebLog(
  level: LogLevel,
  context: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  invoke('write_web_log', {
    level,
    context,
    message,
    data: data ?? null,
  }).catch(() => {})
}
