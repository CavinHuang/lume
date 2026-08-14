export interface PersistScheduler {
  schedule: () => void
  flush: () => Promise<void>
  cancel: () => Promise<void>
}

// Trailing debounce: collapses bursts of message events into one write.
// Crash window is bounded by delayMs; run-final finally persist remains the backstop.
export function createPersistScheduler(
  delayMs: number,
  write: () => Promise<unknown>,
): PersistScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  let inflight: Promise<unknown> | null = null
  const fire = () => {
    timer = null
    if (!pending) return
    pending = false
    inflight = write()
  }
  return {
    schedule: () => {
      pending = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, delayMs)
    },
    flush: async () => {
      if (timer) clearTimeout(timer)
      fire()
      await inflight
    },
    cancel: async () => {
      if (timer) clearTimeout(timer)
      timer = null
      pending = false
      await inflight
    },
  }
}
