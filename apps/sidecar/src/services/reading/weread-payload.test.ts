import { describe, expect, test } from "bun:test";
import { readWereadTimestamp } from "./weread-payload";

describe("readWereadTimestamp", () => {
  test("秒级时间戳归一为毫秒", () => {
    const ts = Date.UTC(2024, 5, 1);
    expect(readWereadTimestamp({ lastReadAt: Math.floor(ts / 1000) })).toBe(ts);
    expect(readWereadTimestamp({ lastReadAt: ts })).toBe(ts);
  });

  test("时长型 readTime/readingTime 不被误判为时间戳(#531 复审 P1)", () => {
    // 累计阅读 3600 秒：<1e11 被 ×1000 归一出 ≈1970-01-01，须被采信窗口拒绝
    expect(readWereadTimestamp({ readTime: 3600 })).toBeUndefined();
    expect(readWereadTimestamp({ readingTime: 3600 })).toBeUndefined();
    // 高优先级真时间戳存在时照常采信，不受低位脏键牵连
    const recentSecs = Math.floor((Date.now() - 60_000) / 1000);
    expect(readWereadTimestamp({ lastReadAt: recentSecs, readTime: 3600 })).toBe(recentSecs * 1000);
  });

  test("采信窗口 [2005-01-01, now+1d]", () => {
    expect(readWereadTimestamp({ lastReadAt: Date.UTC(1999, 0, 1) })).toBeUndefined();
    expect(readWereadTimestamp({ lastReadAt: Date.now() + 3 * 86_400_000 })).toBeUndefined();
    // 时钟小偏差(未来 1h)仍放行
    expect(readWereadTimestamp({ lastReadAt: Date.now() + 3_600_000 })).toBeDefined();
  });

  test("嵌套 readInfo 优先且同样受窗口约束，被拒后回退顶层链", () => {
    const ts = Date.UTC(2025, 10, 20);
    expect(
      readWereadTimestamp({ readInfo: { updateTime: Math.floor(ts / 1000) }, lastReadAt: 3600 })
    ).toBe(ts);
    expect(
      readWereadTimestamp({
        readInfo: { updateTime: 3600 },
        lastReadAt: Date.UTC(2026, 0, 1)
      })
    ).toBe(Date.UTC(2026, 0, 1));
  });

  test("0 值终止 ?? 链并被 >0 拒绝（既有语义，键缺失才落下一键）", () => {
    const ts = Date.UTC(2024, 11, 25);
    expect(readWereadTimestamp({ lastReadAt: 0 })).toBeUndefined();
    expect(readWereadTimestamp({ lastReadAt: null, readAt: Math.floor(ts / 1000) })).toBe(ts);
  });
});
