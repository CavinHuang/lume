export interface BrowserToolSession {
  activeTabId?: string
  browserSessionId: string
  browserTurnId: string
  snapshot?: {
    generation: number
    refs: Record<string, { name: string; nth?: number; role: string }>
    snapshotId: string
    tabId: string
  }
  threadId: string
}

export class BrowserToolSessionRegistry {
  private readonly sessions = new Map<string, BrowserToolSession>()

  getOrCreate(threadId: string): BrowserToolSession {
    let session = this.sessions.get(threadId)
    if (!session) {
      const sessionId = `browser-tools:${threadId}`
      session = { browserSessionId: sessionId, browserTurnId: sessionId, threadId }
      this.sessions.set(threadId, session)
    }
    return session
  }

  take(threadId: string): BrowserToolSession | undefined {
    const session = this.sessions.get(threadId)
    this.sessions.delete(threadId)
    return session
  }
}

const registry = new BrowserToolSessionRegistry()

export function getBrowserToolSessionRegistry(): BrowserToolSessionRegistry { return registry }
