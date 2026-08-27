export interface BrowserToolSession {
  activeTabId?: string
  blockedActionLoop?: {
    code: string
    generation: number
    /** 非 ref 工具（run_script/upload/download/fill_secret）的熔断无 ref（#661） */
    ref?: string
    tabId: string
    tool: string
  }
  browserSessionId: string
  browserTurnId: string
  lastNonRetryableActionFailure?: { attempts: number; code: string; key: string }
  /** 结果未知的已派发动作指纹(executed_unknown):同代际盲目重试在发起前拦截(#603)。
   *  key 为 [tool, stableArgs];generation 为动作发起时的快照代际。 */
  unknownOutcomeActions?: Map<string, { attempts: number; generation: number }>
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
