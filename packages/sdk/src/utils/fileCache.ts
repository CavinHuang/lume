/**
 * File State LRU Cache
 *
 * Bounded cache for file contents with path normalization.
 * Used to track file states for compaction diffs and
 * avoiding redundant reads.
 */

import { canonicalizePath, toPathKey } from './pathing.js'

/**
 * 记账口径（#655 终局 review：性能与资源）：字符数 × 2。
 *
 * 上限约束的是进程内存驻留而非磁盘字节：JS 字符串在 V8 中按 UTF-16 存放
 * （最高 2 字节/字符，Latin1 单字节串更省），而 Buffer.byteLength(utf-8)
 * 是磁盘口径（ASCII 1 字节/字、CJK 3 字节/字）——两种货币互相高估低估。
 * 统一按「字符数×2」的最坏驻留上界记账：宁可高估，不让真实驻留击穿上限。
 */
function residencyWeight(content: string): number {
  return content.length * 2
}

/**
 * Cached file state.
 */
export interface FileState {
  content: string
  timestamp: number
  /** File size at read/write time, used to reject stale overwrites. */
  size?: number
  offset?: number
  limit?: number
  isPartialView?: boolean
  /** #564:同一 offset/limit 键可对应 raw 与 outline 两种视图,unchanged 判定须区分 */
  summarizedView?: boolean
}

/**
 * LRU file state cache with size limits.
 *
 * 容量调优建议（#655）：默认 100 条/25MB 是 per-run 时代的存量值；宿主把
 * cache 提升为 thread 级长寿命共享后（见 sidecar thread-file-state-cache），
 * 大型重构扫描单 run 读超百文件即触顶、被驱逐文件的下次 Edit 会吃一次
 * not_read 重读往返。如需缓解可由宿主注入更大的 maxEntries（如 1024），
 * 本类不擅自扩容硬上限。
 */
export class FileStateCache {
  private cache = new Map<string, FileState>()
  /**
   * 被容量策略丢弃的路径记录（FIFO 有界，仅存路径不存内容）：
   * 用于 not_read 文案区分「从未读过」与「读过但记录没保住」，让模型
   * 自愈路径更短（并发方向终局 review·发现 A）。上界 = maxEntries×2，
   * 记录本身被 FIFO 挤掉时回退为「从未读过」文案——仍 fail-closed 引导重读。
   */
  private droppedPaths = new Map<string, true>()
  private maxEntries: number
  private maxSizeBytes: number
  private currentSizeBytes = 0

  constructor(maxEntries: number = 100, maxSizeBytes: number = 25 * 1024 * 1024) {
    this.maxEntries = maxEntries
    this.maxSizeBytes = maxSizeBytes
  }

  /**
   * Normalize a file path for cache lookup.
   *
   * key 按文件身份归一:canonicalizePath 解析 symlink(f4643e04 收口后
   * Read 走 resolveInputPath 存 realpath,而 NotebookEditTool 等词法
   * resolve——同一文件两种拼写必须命中同一条目,否则 read-before-edit
   * 校验在 macOS /tmp、/var 等 symlink 环境整体失效),toPathKey 叠加
   * 大小写归一(macOS/Windows 不敏感盘)。
   */
  private normalizePath(filePath: string): string {
    return toPathKey(canonicalizePath(filePath))
  }

  /**
   * Get a cached file state.
   */
  get(filePath: string): FileState | undefined {
    const key = this.normalizePath(filePath)
    const entry = this.cache.get(key)
    if (entry) {
      // Move to end (most recently used)
      this.cache.delete(key)
      this.cache.set(key, entry)
    }
    return entry
  }

  /**
   * Set a cached file state.
   */
  set(filePath: string, state: FileState): void {
    const key = this.normalizePath(filePath)
    const newWeight = residencyWeight(state.content)

    // 单条目超上限直接拒绝缓存（#655 实测复刻）：旧实现先清空全表再无条件
    // 放入，30MB 文件把全部条目驱逐后自身驻留、字节上限被击穿。拒绝时不动
    // 任何现有条目；该文件的读取记录视为「被容量策略丢弃」，后续 not_read
    // 文案会如实告知（wasDroppedByCapacity）。
    if (newWeight > this.maxSizeBytes) {
      this.recordDrop(key)
      return
    }

    // Remove old entry if exists
    const old = this.cache.get(key)
    if (old) {
      this.currentSizeBytes -= residencyWeight(old.content)
      this.cache.delete(key)
    }

    // Evict entries if necessary
    while (
      (this.cache.size >= this.maxEntries || this.currentSizeBytes + newWeight > this.maxSizeBytes) &&
      this.cache.size > 0
    ) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        const entry = this.cache.get(firstKey)
        if (entry) {
          this.currentSizeBytes -= residencyWeight(entry.content)
        }
        this.cache.delete(firstKey)
        this.recordDrop(firstKey)
      }
    }

    this.cache.set(key, state)
    this.currentSizeBytes += newWeight
  }

  /**
   * 该路径的读取记录是否曾被容量策略丢弃（LRU 驱逐或单条目超限拒存）。
   * 供工具层 not_read 文案区分「从未读过」与「读过但记录没保住」。
   */
  wasDroppedByCapacity(filePath: string): boolean {
    return this.droppedPaths.has(this.normalizePath(filePath))
  }

  private recordDrop(key: string): void {
    this.droppedPaths.set(key, true)
    while (this.droppedPaths.size > this.maxEntries * 2) {
      const oldest = this.droppedPaths.keys().next().value
      if (!oldest) break
      this.droppedPaths.delete(oldest)
    }
  }

  /**
   * Delete a cached entry.
   */
  delete(filePath: string): boolean {
    const key = this.normalizePath(filePath)
    const entry = this.cache.get(key)
    if (entry) {
      this.currentSizeBytes -= residencyWeight(entry.content)
      this.cache.delete(key)
      return true
    }
    return false
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear()
    this.droppedPaths.clear()
    this.currentSizeBytes = 0
  }

  /**
   * Get the number of cached entries.
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * 当前记账总量（字符数×2 驻留口径），供线程注册表做全局聚合上限。
   */
  get accountedBytes(): number {
    return this.currentSizeBytes
  }

  /**
   * Get all cached file paths.
   */
  keys(): string[] {
    return Array.from(this.cache.keys())
  }

  /**
   * Clone the cache.
   */
  clone(): FileStateCache {
    const clone = new FileStateCache(this.maxEntries, this.maxSizeBytes)
    for (const [key, value] of this.cache) {
      clone.cache.set(key, { ...value })
    }
    clone.currentSizeBytes = this.currentSizeBytes
    return clone
  }
}
