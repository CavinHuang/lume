type Release = () => void

/** Process-local lifecycle serialization; durable stores remain independently committed. */
export class AgentLifecycleLockManager {
  readonly #tails = new Map<string, Promise<void>>()
  readonly #held = new Set<string>()

  isHeld(resource: string): boolean { return this.#held.has(resource) }

  tryAcquire(resources: readonly string[]): Release | undefined {
    const ordered = orderResources(resources)
    if (ordered.some((resource) => this.#tails.has(resource))) return undefined
    const releases: Release[] = []
    for (const resource of ordered) {
      let release!: () => void
      const tail = new Promise<void>((resolve) => { release = resolve })
      this.#tails.set(resource, tail)
      this.#held.add(resource)
      releases.push(() => {
        this.#held.delete(resource)
        release()
        if (this.#tails.get(resource) === tail) this.#tails.delete(resource)
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const release of releases.reverse()) release()
    }
  }

  async acquire(resources: readonly string[]): Promise<Release> {
    const ordered = orderResources(resources)
    const releases: Release[] = []
    for (const resource of ordered) {
      const previous = this.#tails.get(resource) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => { release = resolve })
      const tail = previous.then(() => current)
      this.#tails.set(resource, tail)
      await previous
      this.#held.add(resource)
      releases.push(() => {
        this.#held.delete(resource)
        release()
        if (this.#tails.get(resource) === tail) this.#tails.delete(resource)
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const release of releases.reverse()) release()
    }
  }

  async runExclusive<T>(resources: readonly string[], action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(resources)
    try { return await action() } finally { release() }
  }
}

function orderResources(resources: readonly string[]): string[] {
  return [...new Set(resources)].sort((left, right) => {
    const rank = (value: string) => value.startsWith('workspace:') ? 0 : 1
    return rank(left) - rank(right) || left.localeCompare(right)
  })
}

export const agentLifecycleLocks = new AgentLifecycleLockManager()
