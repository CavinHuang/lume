/**
 * Compaction 状态存储与配置管理
 *
 * 维护每个 session 的最新 CompactionEntry（内存 Map），
 * 以及从环境变量/默认值解析 CompactionSettings。
 */

import type { CompactionSettings } from "./compaction-service";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000
};

export function getCompactionSettings(): CompactionSettings {
  const envEnabled = process.env.LUME_COMPACTION_ENABLED;
  const envReserve = process.env.LUME_COMPACTION_RESERVE_TOKENS;
  const envKeep = process.env.LUME_COMPACTION_KEEP_RECENT_TOKENS;

  return {
    enabled: envEnabled !== undefined ? envEnabled !== "0" && envEnabled !== "false" : DEFAULT_SETTINGS.enabled,
    reserveTokens: envReserve ? Number(envReserve) : DEFAULT_SETTINGS.reserveTokens,
    keepRecentTokens: envKeep ? Number(envKeep) : DEFAULT_SETTINGS.keepRecentTokens
  };
}

// ---------------------------------------------------------------------------
// 存储（内存 Map）
// ---------------------------------------------------------------------------

export interface StoredCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

const store = new Map<string, StoredCompaction>();

export function getStoredCompaction(sessionId: string): StoredCompaction | null {
  return store.get(sessionId) ?? null;
}

export function saveStoredCompaction(
  sessionId: string,
  result: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }
): void {
  store.set(sessionId, {
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
    details: result.details
  });
  console.log(
    `[Compaction] 已保存 session=${sessionId} 摘要（tokensBefore=${result.tokensBefore}, firstKeptEntryId=${result.firstKeptEntryId}）`
  );
}

export function clearStoredCompaction(sessionId: string): void {
  store.delete(sessionId);
}
