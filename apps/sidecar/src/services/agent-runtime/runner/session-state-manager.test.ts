import { describe, expect, test } from "bun:test";
import { pruneExpiredSessionStates } from "./session-state-manager";

// 单例在模块加载时读盘且受 preload 时序影响，因此只测纯判定逻辑；
// cleanupExpired 的"cleaned>0 时落盘"由类内实现保证（回滚实验背书，#615）。
describe("pruneExpiredSessionStates（#615）", () => {
  const now = 1_000_000_000_000;
  const makeState = (updatedAt: number) => ({
    sessionId: "s",
    totalTokens: 0,
    contextWindow: 200000,
    compactionCount: 0,
    createdAt: updatedAt,
    updatedAt
  });

  test("过期条目被剔除并计数，新鲜条目保留", () => {
    const states = {
      expired: makeState(now - 25 * 3_600_000),
      fresh: makeState(now - 1 * 3_600_000)
    };
    const { next, cleaned } = pruneExpiredSessionStates(states, now);
    expect(cleaned).toBe(1);
    expect(next.expired).toBeUndefined();
    expect(next.fresh).toBeDefined();
  });

  test("恰好等于 maxAge 不剔除（严格大于判定）", () => {
    const boundary = now - 24 * 3_600_000;
    const { next, cleaned } = pruneExpiredSessionStates({ boundary: makeState(boundary) }, now);
    expect(cleaned).toBe(0);
    expect(next.boundary).toBeDefined();
  });
});
