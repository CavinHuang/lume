export interface TrayStateThread {
  id: string
  title: string
  updatedAt: number
}

export interface ValidTrayState {
  threads: TrayStateThread[]
  currentThreadId: string | null
}

export function isMainWindowSender(mainWindowWebContentsId: number | null, ownerWebContentsId: unknown): boolean {
  return mainWindowWebContentsId !== null && ownerWebContentsId === mainWindowWebContentsId
}

export function destroyTrayWithFallback(destroy: () => void, onError: (error: unknown) => void): boolean {
  try {
    destroy()
    return true
  } catch (error) {
    onError(error)
    return false
  }
}

export function validateTrayStatePayload(
  payload: unknown,
  expectedGeneration: number,
): { ok: true; value: ValidTrayState } | { ok: false; reason: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'invalid_payload' }
  const value = payload as Record<string, unknown>
  if (value.generation !== expectedGeneration) return { ok: false, reason: 'stale_generation' }

  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
  if (new TextEncoder().encode(serialized).byteLength > 8_192) return { ok: false, reason: 'payload_too_large' }
  if (!Array.isArray(value.threads) || value.threads.length > 5) return { ok: false, reason: 'invalid_threads' }

  const ids = new Set<string>()
  const threads: TrayStateThread[] = []
  for (const item of value.threads) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'invalid_thread' }
    const thread = item as Record<string, unknown>
    if (typeof thread.id !== 'string' || thread.id.length < 1 || thread.id.length > 128 || ids.has(thread.id)) {
      return { ok: false, reason: 'invalid_thread_id' }
    }
    if (typeof thread.title !== 'string' || thread.title.length > 256) return { ok: false, reason: 'invalid_thread_title' }
    if (typeof thread.updatedAt !== 'number' || !Number.isFinite(thread.updatedAt) || thread.updatedAt < 0) {
      return { ok: false, reason: 'invalid_thread_updated_at' }
    }
    ids.add(thread.id)
    threads.push({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt })
  }

  const currentThreadId = value.currentThreadId
  if (currentThreadId != null && (
    typeof currentThreadId !== 'string'
    || currentThreadId.length < 1
    || currentThreadId.length > 128
  )) return { ok: false, reason: 'invalid_current_thread_id' }

  return {
    ok: true,
    value: {
      threads,
      currentThreadId: typeof currentThreadId === 'string' ? currentThreadId : null,
    },
  }
}

export function createEventRateLimiter({
  windowMs = 10_000,
  now = Date.now,
}: {
  windowMs?: number
  now?: () => number
} = {}) {
  const entries = new Map<string, { startedAt: number; suppressed: number }>()
  return {
    record(key: string): { allowed: boolean; suppressedCount: number } {
      const timestamp = now()
      const entry = entries.get(key)
      if (!entry || timestamp - entry.startedAt >= windowMs) {
        const suppressedCount = entry?.suppressed ?? 0
        entries.set(key, { startedAt: timestamp, suppressed: 0 })
        return { allowed: true, suppressedCount }
      }
      entry.suppressed += 1
      return { allowed: false, suppressedCount: entry.suppressed }
    },
  }
}

export function createAsyncSingleFlight<T>() {
  let inFlight: Promise<T> | null = null
  return {
    run(factory: () => T | Promise<T>): Promise<T> {
      if (inFlight) return inFlight
      const active = Promise.resolve()
        .then(factory)
        .finally(() => {
          if (inFlight === active) inFlight = null
        })
      inFlight = active
      return active
    },
    hasInFlight: () => inFlight !== null,
  }
}

export function createMainWindowLifecycleState<TPayload = unknown>() {
  let generation = 0
  let rendererReadyGeneration = 0
  let acceptedWindowBehaviorRevision = -1
  let pendingNavigation: { generation: number; payload: TPayload } | null = null

  return {
    beginGeneration() {
      generation += 1
      rendererReadyGeneration = 0
      acceptedWindowBehaviorRevision = -1
      return generation
    },
    getGeneration: () => generation,
    isCurrent: (candidate: number) => candidate === generation,
    isRendererReady: (candidate: number) => candidate === rendererReadyGeneration,
    acceptWindowBehaviorRevision(candidateGeneration: number, revision: unknown) {
      if (candidateGeneration !== generation || !Number.isSafeInteger(revision) || (revision as number) <= acceptedWindowBehaviorRevision) return false
      acceptedWindowBehaviorRevision = revision as number
      return true
    },
    queueNavigation(candidateGeneration: number, payload: TPayload) {
      if (candidateGeneration !== generation) return { accepted: false, replaced: false }
      const replaced = pendingNavigation?.generation === candidateGeneration
      pendingNavigation = { generation: candidateGeneration, payload }
      return { accepted: true, replaced }
    },
    markRendererReady(candidateGeneration: number) {
      if (candidateGeneration !== generation) return { accepted: false, payload: null as TPayload | null }
      rendererReadyGeneration = candidateGeneration
      if (pendingNavigation?.generation !== candidateGeneration) return { accepted: true, payload: null as TPayload | null }
      const payload = pendingNavigation.payload
      pendingNavigation = null
      return { accepted: true, payload }
    },
    closeGeneration(closedGeneration: number) {
      if (pendingNavigation?.generation === closedGeneration) pendingNavigation = null
      if (closedGeneration !== generation) return false
      rendererReadyGeneration = 0
      acceptedWindowBehaviorRevision = -1
      return true
    },
    getPendingNavigation: () => pendingNavigation,
  }
}

interface WindowReadyTarget {
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown
  removeListener(event: 'ready-to-show' | 'closed', listener: () => void): unknown
}

export function waitForWindowReady(
  target: WindowReadyTarget,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      target.removeListener('ready-to-show', onReady)
      target.removeListener('closed', onClosed)
    }
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onReady = () => settle()
    const onClosed = () => settle(new Error('main window closed before ready'))
    const timeout = setTimeout(() => settle(new Error('main window ready timeout')), timeoutMs)
    timeout.unref?.()
    target.once('ready-to-show', onReady)
    target.once('closed', onClosed)
  })
}
