import type { BrowserTabDescriptor } from "@lume/shared"

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
  /** #604①:list_tabs 会话级微缓存(TTL 内复用)。open/reconcile 失配/switch 未命中即失效；
   *  外部关 tab 超出 TTL 的窗口由 reconcile 自愈兜底。 */
  tabsCache?: { tabs: BrowserTabDescriptor[]; fetchedAt: number }
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

  /** #838②:desktop 推送 tab 生命周期事件(tab-closed/tab-changed)时清全部会话的
   *  list_tabs 微缓存——外部关 tab 的失效窗口从 ≤1s(TTL)压到 0;TTL 与
   *  tab_not_found 错误驱动防线保留为纵深。 */
  invalidateTabsCaches(): void {
    for (const session of this.sessions.values()) session.tabsCache = undefined
  }
}

const registry = new BrowserToolSessionRegistry()

export function getBrowserToolSessionRegistry(): BrowserToolSessionRegistry { return registry }
