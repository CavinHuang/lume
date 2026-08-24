import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  collectDiagnostics,
  detectDiagnosticsChecker,
  formatDiagnosticsMessage,
  isDiagnosticEligibleFile,
  parseEslintJson,
  parseTscOutput,
} from "./coding-diagnostics";

describe("coding diagnostics", () => {
  test("#573①: 可诊断扩展名判定", () => {
    expect(isDiagnosticEligibleFile("src/a.ts")).toBe(true);
    expect(isDiagnosticEligibleFile("src/a.mjs")).toBe(true);
    expect(isDiagnosticEligibleFile("src/a.py")).toBe(false);
    expect(isDiagnosticEligibleFile("README.md")).toBe(false);
  });

  test("#573①: checker 探测——tsconfig+tsc 安装则 tsc 优先，否则 eslint，均缺为 null", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-diag-"));
    try {
      expect(detectDiagnosticsChecker(root)).toBeNull();
      mkdirSync(join(root, "node_modules", "eslint", "bin"), { recursive: true });
      writeFileSync(join(root, "node_modules", "eslint", "bin", "eslint.js"), "//");
      writeFileSync(join(root, ".eslintrc.json"), "{}");
      expect(detectDiagnosticsChecker(root)).toBe("eslint");
      mkdirSync(join(root, "node_modules", "typescript", "lib"), { recursive: true });
      // 官方包布局：编译器在 lib/tsc.js（review 实证 bin/ 只有 shim）
      writeFileSync(join(root, "node_modules", "typescript", "lib", "tsc.js"), "//");
      writeFileSync(join(root, "tsconfig.json"), "{}");
      expect(detectDiagnosticsChecker(root)).toBe("tsc");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#573①: tsc 输出解析只取 error 行", () => {
    const stdout = [
      "src/a.ts(12,34): error TS2345: Argument of type 'number' is not assignable.",
      "src/b.ts(3,1): warning TS6133: 'x' is declared but never used.",
      "not an error line",
    ].join("\n");
    const entries = parseTscOutput(stdout);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ file: "src/a.ts", line: 12, column: 34, code: "TS2345" });
  });

  test("#573①: eslint json 解析只取 severity=2", () => {
    const stdout = JSON.stringify([
      {
        filePath: "C:\\repo\\src\\a.ts",
        messages: [
          { line: 4, column: 2, severity: 2, ruleId: "no-unused-vars", message: "'x' is defined but never used." },
          { line: 9, column: 1, severity: 1, ruleId: "semi", message: "Missing semicolon." },
        ],
      },
    ]);
    const entries = parseEslintJson(stdout);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ file: "C:/repo/src/a.ts", line: 4, code: "no-unused-vars" });
  });

  test("#573①: 消息格式带编辑文件优先与溢出提示", () => {
    const message = formatDiagnosticsMessage({
      checker: "tsc",
      entries: [{ file: "src/a.ts", line: 12, code: "TS2345", message: "type mismatch" }],
      totalErrors: 15,
      timedOut: false,
    });
    expect(message).toContain("[diagnostics] 类型检查检测到 15 个错误（编辑过的文件优先展示）");
    expect(message).toContain("src/a.ts:12 [TS2345] type mismatch");
    expect(message).toContain("其余 14 个错误未展开");
  });

  test("#573①: 无 checker 的仓返回 null（现有测试仓行为不变）", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-diag-"));
    try {
      await expect(collectDiagnostics({ workspaceRoot: root, files: ["a.ts"] })).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
