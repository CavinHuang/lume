import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withIndexMutationLock } from "./index-mutation-lock";

describe("withIndexMutationLock", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("释放时不得删除已被其他持有者替换的锁", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-index-lock-owner-"));
    roots.push(root);
    const lockPath = join(root, "index.lock");
    const replacement = JSON.stringify({ pid: process.pid, token: "replacement", createdAt: Date.now() });

    withIndexMutationLock(lockPath, () => {
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, replacement, "utf-8");
    });

    expect(existsSync(lockPath)).toBeTrue();
    expect(readFileSync(lockPath, "utf-8")).toBe(replacement);
  });
});
