import { describe, expect, test } from "bun:test";
import { getStreamRefreshRecentLimit } from "./stream-refresh-policy";

describe("stream-refresh-policy", () => {
  test("未分页时应额外预留 2 条缓冲", () => {
    const limit = getStreamRefreshRecentLimit({
      visibleCount: 20,
      hadMore: false,
      minLimit: 10
    });
    expect(limit).toBe(22);
  });

  test("分页时应额外预留 1 条缓冲", () => {
    const limit = getStreamRefreshRecentLimit({
      visibleCount: 20,
      hadMore: true,
      minLimit: 10
    });
    expect(limit).toBe(21);
  });

  test("可见窗口过小时应至少返回最小窗口", () => {
    const limit = getStreamRefreshRecentLimit({
      visibleCount: 0,
      hadMore: true,
      minLimit: 10
    });
    expect(limit).toBe(10);
  });
});
