export interface PersistScheduler {
  schedule: () => void
  flush: () => void
  cancel: () => void
}

// Trailing debounce: collapses bursts of message events into one write.
// Crash window is bounded by delayMs; run-final finally flush remains the backstop.
export function createPersistScheduler(
  delayMs: number,
  write: () => Promise<unknown>,
): PersistScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  const fire = () => {
    timer = null
    if (!pending) return
    pending = false
    void write()
  }
  return {
    schedule: () => {
      pending = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, delayMs)
    },
    flush: () => {
      if (timer) clearTimeout(timer)
      fire()
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
      pending = false
    },
  }
}
