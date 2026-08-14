import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReadingLibraryPath } from "../infra/config-paths";
import { ensureReadingBootstrapBook, listReadingBooks } from "./reading-store";

/**
 * 回归：ensureReadingBootstrapBook 会被快照与阅读任务触发，旧实现仅以
 * `library.books.length === 0` 为播种条件。一旦库「瞬时为空」（跨进程/读失败回退空库），
 * 就会重新种入一本《人间词话》，历史累积出多本重复种子书。
 *
 * 根治：bootstrap 一生只发生一次（标记文件），标记存在后即便库被清空也不再种。
 */
describe("ensureReadingBootstrapBook", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-bootstrap-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("首次空库种入 1 本；之后即使库被清空也不重复种", () => {
    const first = ensureReadingBootstrapBook();
    expect(first).not.toBeNull();
    expect(first?.title).toBe("人间词话");
    expect(listReadingBooks()).toHaveLength(1);

    // 已有书时再调：不种
    expect(ensureReadingBootstrapBook()).toBeNull();
    expect(listReadingBooks()).toHaveLength(1);

    // 模拟「库瞬时为空」（跨进程/读解析失败等）：标记仍在 → 不应再种
    const lib = JSON.parse(readFileSync(getReadingLibraryPath(), "utf-8"));
    lib.books = [];
    writeFileSync(getReadingLibraryPath(), JSON.stringify(lib), "utf-8");
    expect(ensureReadingBootstrapBook()).toBeNull(); // 旧代码这里会重新种一本
    expect(listReadingBooks()).toHaveLength(0);
  });
});
