// 多列虚拟化布局参数（与 ProviderCard 固定高度对齐）
export const PROVIDER_GRID = {
  minCardWidth: 216, // 对齐 wanta 的 13.5rem 目录卡片下限
  cardHeight: 68,    // ProviderCard 紧凑行高度（对齐 wanta 68px）
  gap: 8,            // 对齐 wanta 的紧凑目录间距
  overscanRows: 4,
} as const;

/** 容器宽度 → 列数（按最小卡片宽度取下整，至少 1 列）。 */
export function computeColumnCount(
  containerWidth: number,
  minCardWidth: number = PROVIDER_GRID.minCardWidth,
): number {
  if (containerWidth <= 0) return 1;
  return Math.max(1, Math.floor((containerWidth + PROVIDER_GRID.gap) / (minCardWidth + PROVIDER_GRID.gap)));
}

/** 条目数 + 列数 → 行数（列数 ≤0 时返回 0）。 */
export function rowCount(itemCount: number, columns: number): number {
  if (columns <= 0) return 0;
  return Math.ceil(itemCount / columns);
}
