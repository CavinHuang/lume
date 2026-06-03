import { describe, expect, test } from "bun:test";
import { validateReadingQuoteEvidence } from "./quote-evidence";

describe("reading quote evidence", () => {
  test("accepts quotes found in saved source excerpts", () => {
    expect(validateReadingQuoteEvidence([
      {
        quote: "把自己看作一个普通人，过普通人的生活。",
        sourceKind: "weread",
        excerpt: "他说：把自己看作一个普通人，过普通人的生活。这里没有戏剧性的姿态。",
        capturedAt: 1
      }
    ])).toEqual({ ok: true });
  });

  test("rejects claimed quotes that are not backed by the excerpt", () => {
    expect(validateReadingQuoteEvidence([
      {
        quote: "这句并不在原文里。",
        sourceKind: "weread",
        excerpt: "把自己看作一个普通人，过普通人的生活。",
        capturedAt: 1
      }
    ])).toEqual({
      ok: false,
      reason: "引用缺少原文证据: 这句并不在原文里。"
    });
  });
});
