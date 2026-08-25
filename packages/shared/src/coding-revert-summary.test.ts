import { describe, expect, test } from "bun:test";
import { formatCodingFileRevertNotice, formatCodingRevertSummary } from "./coding-revert-summary";

/** #714：Run 快照还原摘要按桶计数；桌面 notice 与 IM /revert 回复共用此口径 */
describe("formatCodingRevertSummary", () => {
  test("全成功只报还原数", () => {
    expect(formatCodingRevertSummary({
      filesChanged: ["a.ts", "b.ts"],
      conflicts: [],
      committedPaths: [],
      failedFiles: [],
    })).toBe("已还原 2 个文件");
  });

  test("四桶各自出现且顺序固定（conflicts → committed → failed）", () => {
    const summary = formatCodingRevertSummary({
      filesChanged: ["a.ts"],
      conflicts: ["c1.ts", "c2.ts"],
      committedPaths: ["g1.ts"],
      failedFiles: ["f1.ts", "f2.ts", "f3.ts"],
    });
    expect(summary).toBe(
      "已还原 1 个文件；2 个因 Run 后被外部修改而跳过；1 个已提交不可回退；3 个还原失败",
    );
  });

  test("零桶不产生空片段", () => {
    const summary = formatCodingRevertSummary({
      filesChanged: [],
      conflicts: [],
      committedPaths: [],
      failedFiles: [],
    });
    expect(summary).toBe("已还原 0 个文件");
    expect(summary).not.toContain("；");
  });
});

describe("formatCodingFileRevertNotice", () => {
  test("restored 返回 null 走成功提示", () => {
    expect(formatCodingFileRevertNotice({ status: "restored", filesChanged: ["a"], nonRewindableFiles: [] })).toBeNull();
  });

  test("committed_boundary 与 conflict 各有明确文案", () => {
    expect(formatCodingFileRevertNotice({ status: "committed_boundary", filesChanged: [], nonRewindableFiles: ["a"] }))
      .toContain("已提交");
    expect(formatCodingFileRevertNotice({ status: "conflict", filesChanged: [], nonRewindableFiles: ["a"] }))
      .toContain("外部修改");
  });
});
