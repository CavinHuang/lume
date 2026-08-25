import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanTempDirectories, tempDirPrefix } from "./temp-files";

describe("sweepOrphanTempDirectories", () => {
  test("只删 mtime 超龄的 oomol-connect-* 目录,新鲜目录与其他前缀不动", () => {
    const stale = join(tmpdir(), `${tempDirPrefix}sweep-test-stale-${process.pid}`);
    const fresh = join(tmpdir(), `${tempDirPrefix}sweep-test-fresh-${process.pid}`);
    const unrelated = join(tmpdir(), `unrelated-sweep-test-${process.pid}`);
    for (const dir of [stale, fresh, unrelated]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
    }
    // 把 stale 的 mtime 拨回 2 天前
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    try {
      sweepOrphanTempDirectories();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      for (const dir of [fresh, unrelated]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
