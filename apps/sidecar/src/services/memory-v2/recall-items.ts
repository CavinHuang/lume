import type { MemoryV2RecallItem } from "./types";

/**
 * recall 条目公共判定/合并原语(#531 收敛)：retrieval / user-message-prefix /
 * context-selection 三处同型拷贝收敛于此。
 */

/** 会话历史类 recall（daily/run 注入项），排序与摘要管线按此分流。 */
export function isConversationHistory(item: MemoryV2RecallItem): boolean {
  return item.reason === "recent daily memory"
    || item.reason === "recent run memory"
    || item.id.includes(":daily:")
    || item.id.includes(":run:");
}

/** 按 id 去重，保留得分更高的一份。 */
export function mergeRecallItems(items: MemoryV2RecallItem[]): MemoryV2RecallItem[] {
  const byId = new Map<string, MemoryV2RecallItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing || item.score > existing.score) byId.set(item.id, item);
  }
  return [...byId.values()];
}
