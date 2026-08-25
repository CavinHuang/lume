import { FileStateCache } from "@lume/agent-sdk";

/**
 * 线程级 fileStateCache 持有处（#569）。
 *
 * sidecar 每条用户消息经 createRuntimeCoreSession 新建一个 SDK Agent 实例；
 * 把同一个 FileStateCache 按 threadId 注入每个 Agent，stale-read 防护才能
 * 跨消息存活。分工：本 cache（SDK 层）只做 mtime/size/content 新鲜度判定；
 * "写入前须完整读"的产品级门控由 file-access-ledger 负责，两层互不替代。
 *
 * 生命周期：线程删除时清理（agent-thread-manager deleteAgentThread），
 * 进程退出随内存消亡；记录丢失时守卫 fail-closed（引导重读）。
 */
const threadCaches = new Map<string, FileStateCache>();

/** 逻辑时钟（单调递增）：Date.now() 同毫秒撞值会破坏最久未用判定。 */
let lastUsedClock = 0;
const threadLastUsedAt = new Map<string, number>();

/**
 * 全局聚合上限（#655 终局 review：性能与资源）：
 * 单 cache 自身有 100 条/25MB 封顶，但 N 个常开线程聚合无上界（最坏
 * N×25MB）。超限整条淘汰「最久未用」的线程 cache——粒度粗但实现薄；
 * 被淘汰线程的下一条消息拿到空 cache，守卫 fail-closed 引导重读，
 * 正确性不受影响。字节口径与单 cache 相同（字符数×2 驻留估计）。
 *
 * 取舍说明：字节增长发生在消息执行期，收敛点在下次消息分发的本函数调用
 * （单消息单线程增量 ≤ 单 cache 的 25MB 上限）；测试可临时改写后还原。
 */
export const THREAD_CACHE_GLOBAL_LIMITS = {
  /** 常开线程 cache 数上限。 */
  maxThreads: 128,
  /** 全部线程 cache 记账字节聚合上限。 */
  maxTotalBytes: 256 * 1024 * 1024,
};

export function getThreadFileStateCache(threadId: string): FileStateCache {
  // 先触碰时钟再做容量裁决：当前线程拿到最新时间戳，不会被自己淘汰；
  // 新建前 reserveSlot 预留一个名额。prune 后重读一次——极端退化
  // （如测试把字节上限调到单线程即超限）下可能把自己整条淘汰，此时
  // 就地惰性重建，保证恒返回已注册实例。
  const isNew = !threadCaches.has(threadId);
  threadLastUsedAt.set(threadId, ++lastUsedClock);
  pruneThreadCaches(isNew);
  let cache = threadCaches.get(threadId);
  if (!cache) {
    cache = new FileStateCache();
    threadCaches.set(threadId, cache);
  }
  return cache;
}

function pruneThreadCaches(reserveSlot: boolean): void {
  for (;;) {
    let totalBytes = 0;
    for (const cache of threadCaches.values()) totalBytes += cache.accountedBytes;
    const overThreads = threadCaches.size + (reserveSlot ? 1 : 0) > THREAD_CACHE_GLOBAL_LIMITS.maxThreads;
    const overBytes = totalBytes > THREAD_CACHE_GLOBAL_LIMITS.maxTotalBytes;
    if (!overThreads && !overBytes) return;
    let victimId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, usedAt] of threadLastUsedAt) {
      if (!threadCaches.has(id)) continue;
      if (usedAt < oldestAt) {
        oldestAt = usedAt;
        victimId = id;
      }
    }
    if (!victimId) return;
    dropThreadCache(victimId);
  }
}

function dropThreadCache(threadId: string): void {
  threadCaches.delete(threadId);
  threadLastUsedAt.delete(threadId);
}

export function clearThreadFileStateCache(threadId: string): void {
  dropThreadCache(threadId);
}
