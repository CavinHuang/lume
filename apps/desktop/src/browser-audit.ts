import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { BrowserActor, BrowserAuditEvent, BrowserBackendType, BrowserErrorCode } from "../../../packages/shared/src/types/browser-runtime"

const MAX_EVENT_BYTES = 8 * 1024
const MAX_SESSION_BYTES = 2 * 1024 * 1024
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export class BrowserAuditLog {
  private readonly directory: string
  private readonly sessionBytes = new Map<string, number>()

  constructor(configDir: () => string) {
    this.directory = join(configDir(), "browser", "audit")
    mkdirSync(this.directory, { recursive: true })
    this.prune()
  }

  record(input: {
    correlationId: string
    actor: BrowserActor
    threadId?: string
    browserSessionId: string
    tabId?: string
    backend: BrowserBackendType
    generation: number
    origin?: string
    action: string
    decision: BrowserAuditEvent["decision"]
    status: BrowserAuditEvent["status"]
    errorCode?: BrowserErrorCode
    durationMs?: number
  }): BrowserAuditEvent {
    const event: BrowserAuditEvent = {
      eventVersion: 1,
      eventId: randomUUID(),
      correlationId: input.correlationId.slice(0, 128),
      timestamp: new Date().toISOString(),
      actor: input.actor,
      ...(input.threadId ? { threadId: input.threadId.slice(0, 128) } : {}),
      browserSessionId: input.browserSessionId.slice(0, 128),
      ...(input.tabId ? { tabId: input.tabId.slice(0, 128) } : {}),
      backend: input.backend,
      generation: Math.max(0, Math.trunc(input.generation)),
      ...(input.origin ? { origin: sanitizeOrigin(input.origin) } : {}),
      action: input.action.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 96),
      decision: input.decision,
      status: input.status,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.durationMs !== undefined ? { durationMs: Math.max(0, Math.min(300_000, Math.trunc(input.durationMs))) } : {}),
    }
    const encoded = JSON.stringify(event)
    const bytes = Buffer.byteLength(encoded)
    if (bytes > MAX_EVENT_BYTES) throw new Error("browser_audit_event_too_large")
    const used = this.sessionBytes.get(event.browserSessionId) ?? 0
    if (used + bytes > MAX_SESSION_BYTES) return event
    this.sessionBytes.set(event.browserSessionId, used + bytes)
    appendFileSync(join(this.directory, `browser-audit-${event.timestamp.slice(0, 10)}.ndjson`), `${encoded}\n`, { encoding: "utf8", mode: 0o600 })
    return event
  }

  clear(): void {
    this.sessionBytes.clear()
    for (const file of readdirSync(this.directory)) if (/^browser-audit-\d{4}-\d{2}-\d{2}\.ndjson$/.test(file)) rmSync(join(this.directory, file), { force: true })
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS
    for (const file of readdirSync(this.directory)) {
      if (!/^browser-audit-\d{4}-\d{2}-\d{2}\.ndjson$/.test(file)) continue
      const path = join(this.directory, file)
      if (existsSync(path) && statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    }
  }
}

function sanitizeOrigin(value: string): string {
  try { return new URL(value).origin.slice(0, 512) } catch { return "null" }
}
