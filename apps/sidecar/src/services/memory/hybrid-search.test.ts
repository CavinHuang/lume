import { describe, expect, test } from "bun:test";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid-search";

describe("hybrid-search", () => {
  test("buildFtsQuery 应输出 AND 查询", () => {
    expect(buildFtsQuery("commit hash")).toBe('"commit" AND "hash"');
    expect(buildFtsQuery("中文 查询")).toBeNull();
  });

  test("bm25RankToScore 应按排名递减", () => {
    expect(bm25RankToScore(0)).toBe(1);
    expect(bm25RankToScore(1)).toBe(0.5);
    expect(bm25RankToScore(9)).toBe(0.1);
  });

  test("mergeHybridResults 应采用并集并加权", () => {
    const merged = mergeHybridResults({
      vector: [
        { id: "a", score: 0.9, path: "MEMORY.md" },
        { id: "b", score: 0.6, path: "memory/2026-02-12.md" }
      ],
      keyword: [
        { id: "b", score: 0.5, path: "memory/2026-02-12.md" },
        { id: "c", score: 0.8, path: "memory/2026-02-11.md" }
      ],
      vectorWeight: 0.7,
      textWeight: 0.3
    });

    expect(merged.length).toBe(3);
    expect(merged[0]?.id).toBe("a");

    const b = merged.find((item) => item.id === "b");
    const c = merged.find((item) => item.id === "c");

    expect(b?.score).toBeCloseTo(0.57, 6);
    expect(b?.source).toBe("hybrid");
    expect(c?.score).toBeCloseTo(0.24, 6);
  });
});
