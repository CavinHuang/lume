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

export function getThreadFileStateCache(threadId: string): FileStateCache {
  let cache = threadCaches.get(threadId);
  if (!cache) {
    cache = new FileStateCache();
    threadCaches.set(threadId, cache);
  }
  return cache;
}

export function clearThreadFileStateCache(threadId: string): void {
  threadCaches.delete(threadId);
}
