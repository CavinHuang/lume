import { describe, expect, test } from "bun:test";
import { buildPromotionCandidates } from "./file-promotion-candidates";

describe("file-promotion-candidates", () => {
  test("应只保留本轮新增的可提升文件", () => {
    const result = buildPromotionCandidates([
      { name: "report.md", path: "report.md", isDirectory: false },
      { name: "notes.txt", path: "notes.txt", isDirectory: false }
    ], new Set(["notes.txt"]));

    expect(result).toEqual([
      { name: "report.md", path: "report.md", status: "suggested" }
    ]);
  });

  test("应过滤隐藏文件和临时文件", () => {
    const result = buildPromotionCandidates([
      { name: ".DS_Store", path: ".DS_Store", isDirectory: false },
      { name: "run.log", path: "run.log", isDirectory: false },
      { name: "keep.md", path: "keep.md", isDirectory: false }
    ], new Set());

    expect(result).toEqual([
      { name: "keep.md", path: "keep.md", status: "suggested" }
    ]);
  });
});
