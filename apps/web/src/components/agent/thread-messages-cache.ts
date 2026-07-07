import type { AgentMessage } from '@lume/shared'

/**
 * 已加载会话持久化消息的 LRU 缓存。
 *
 * 切会话时 AgentMessages 先用 cache.get(threadId) 立即填充 visibleThreadMessages，
 * 命中则无需等待异步 IPC，从根因消除"先空态再跳底"的空窗；未命中再走 getThreadMessages 拉取，
 * 拉取完成后 cache.set 落盘。
 *
 * 与 runtime events 全局 atom（agentRuntimeEventsAtom 按 threadId 切片）互补：
 * 有 runtime events 的会话切回靠 atom 命中；纯历史会话（atom 无 events）靠本缓存命中。
 *
 * 失效：useGlobalAgentListeners 在 MESSAGE_APPENDED（sidecar 落盘新消息）时 invalidate(threadId)，
 * 保证切回时不会显示 stale 消息。
 */
export class ThreadMessagesCache {
  private readonly entries = new Map<string, AgentMessage[]>()

  constructor(private readonly capacity = 8) {}

  get(threadId: string): AgentMessage[] | undefined {
    const value = this.entries.get(threadId)
    if (value === undefined) return undefined
    // 命中 → 提到最新（Map insertion order 即 LRU recency）
    this.entries.delete(threadId)
    this.entries.set(threadId, value)
    return value
  }

  set(threadId: string, messages: AgentMessage[]): void {
    if (this.entries.has(threadId)) this.entries.delete(threadId)
    this.entries.set(threadId, messages)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  has(threadId: string): boolean {
    return this.entries.has(threadId)
  }

  invalidate(threadId: string): void {
    this.entries.delete(threadId)
  }
}

/** 模块级单例：AgentMessages 读/写，useGlobalAgentListeners 在 MESSAGE_APPENDED 时 invalidate。 */
export const threadMessagesCache = new ThreadMessagesCache()
