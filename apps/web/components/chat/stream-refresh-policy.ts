interface StreamRefreshRecentLimitInput {
  visibleCount: number;
  hadMore: boolean;
  minLimit: number;
}

export function getStreamRefreshRecentLimit(input: StreamRefreshRecentLimitInput): number {
  const safeVisibleCount = Math.max(0, input.visibleCount);
  const buffer = input.hadMore ? 1 : 2;
  return Math.max(input.minLimit, safeVisibleCount + buffer);
}
