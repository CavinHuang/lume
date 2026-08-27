import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  // #526: mtime 过期但持有者仍存活（长持锁）不得被偷——否则双持锁
  test("mtime 过期且持有者存活 → 等待方 fail-fast 抛错而非偷锁", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-index-lock-stale-"));
    roots.push(root);
    const lockPath = join(root, "index.lock");
    const heldPayload = JSON.stringify({ pid: process.pid, token: "held", createdAt: Date.now() });
    writeFileSync(lockPath, heldPayload, "utf-8");
    // 把 mtime 拨回 31s 前，模拟合法长持锁
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);

    expect(() => withIndexMutationLock(lockPath, () => {})).toThrow("超时");
    expect(readFileSync(lockPath, "utf-8")).toBe(heldPayload);
  });

  // #526: 持有者已死（陈旧进程残留锁）→ 即便 mtime 未过期也可安全接管
  test("持有者 pid 已死 → 锁被视为陈旧可接管", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-index-lock-deadpid-"));
    roots.push(root);
    const lockPath = join(root, "index.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, token: "dead", createdAt: Date.now() }), "utf-8");

    const result = withIndexMutationLock(lockPath, () => "acquired");
    expect(result).toBe("acquired");
  });

  // #526 P1: 进程死于 wx 创建与首次原子写之间留下 0 字节锁——无幸存者语义，立即可接管而非空转超时
  test("0 字节残留锁（半写窗口）→ 立即接管", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-index-lock-empty-"));
    roots.push(root);
    const lockPath = join(root, "index.lock");
    writeFileSync(lockPath, "", "utf-8");

    const result = withIndexMutationLock(lockPath, () => "acquired");
    expect(result).toBe("acquired");
  });

  // #526: 非空损坏内容可能来自正处写入间隙的活动持有者——保守走 mtime 通道，不得即刻清除
  test("非空但内容损坏的锁 → 不得即刻清除，等待方超时报错", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-index-lock-broken-"));
    roots.push(root);
    const lockPath = join(root, "index.lock");
    writeFileSync(lockPath, "{broken", "utf-8");

    expect(() => withIndexMutationLock(lockPath, () => {})).toThrow("超时");
    expect(readFileSync(lockPath, "utf-8")).toBe("{broken");
  });

  // #526: 同线程嵌套获取同一路径锁是调用方缺陷，应立刻炸出而非忙等到超时
  test("同线程重入同一路径锁 → 立刻抛重入错误", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-index-lock-reenter-"));
    roots.push(root);
    const lockPath = join(root, "index.lock");

    withIndexMutationLock(lockPath, () => {
      expect(() => withIndexMutationLock(lockPath, () => {})).toThrow("重入");
    });
  });
});
