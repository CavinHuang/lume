import { describe, expect, test } from "bun:test";
import { appendSubagentChangedFiles } from "./run-subagent";

describe("appendSubagentChangedFiles", () => {
  const base = "任务完成，全部验证通过。";

  test("completed 且有变更时追加 Changed files 行", () => {
    const output = appendSubagentChangedFiles(base, "completed", {
      changedFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(output).toBe(`${base}\n\n[Changed files: src/a.ts, src/b.ts]`);
  });

  test("非 completed 状态不附列——失败半成品清单只会误导父级", () => {
    for (const status of ["errored", "aborted", "timed_out"] as const) {
      expect(appendSubagentChangedFiles(base, status, { changedFiles: ["src/a.ts"] })).toBe(base);
    }
  });

  test("空清单与无报告均原样返回", () => {
    expect(appendSubagentChangedFiles(base, "completed", undefined)).toBe(base);
    expect(appendSubagentChangedFiles(base, "completed", {})).toBe(base);
    expect(appendSubagentChangedFiles(base, "completed", { changedFiles: [] })).toBe(base);
    expect(appendSubagentChangedFiles(base, "completed", { changedFiles: ["  ", ""] })).toBe(base);
  });

  test("超过 20 条截断并带溢出标记", () => {
    const files = Array.from({ length: 25 }, (_, i) => `f-${i}.ts`);
    const output = appendSubagentChangedFiles(base, "completed", { changedFiles: files });
    expect(output).toContain("[Changed files: ");
    expect(output).toContain(", +5 more]");
    expect(output).toContain("f-19.ts");
    expect(output).not.toContain("f-20.ts");
  });
});
