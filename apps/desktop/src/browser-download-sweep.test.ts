import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { sweepOrphanDownloads } from "./browser-download-sweep";

const DAY = 24 * 60 * 60_000;

function makeTurn(root: string, session: string, turn: string, files: string[] = ["result.bin"]): string {
  const dir = join(root, session, turn);
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), "x");
  return dir;
}

function age(dir: string, days: number): void {
  // sweep 按目录内文件的 mtime 判定(不 stat 目录自身),回拨需落在文件上
  const past = new Date(Date.now() - days * DAY);
  for (const entry of [dir, ...filesOf(dir)]) {
    try { utimesSync(entry, past, past); } catch { /* 目录项可选 */ }
  }
}

function filesOf(dir: string): string[] {
  return readdirSync(dir).map((entry) => join(dir, entry));
}

describe("sweepOrphanDownloads (#609)", () => {
  test("removes turn directories older than the grace period", () => {
    const root = join(tmpdir(), `sweep-${Math.random().toString(36).slice(2)}`);
    const dir = makeTurn(root, "sess-a", "turn-old");
    age(dir, 2);

    sweepOrphanDownloads(root, [], Date.now());

    expect(existsSync(dir)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("keeps turn directories within the grace period", () => {
    const root = join(tmpdir(), `sweep-${Math.random().toString(36).slice(2)}`);
    const dir = makeTurn(root, "sess-a", "turn-fresh");

    sweepOrphanDownloads(root, [], Date.now());

    expect(existsSync(dir)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("keeps the turn of a live ref even when its mtime is stale (long task window)", () => {
    const root = join(tmpdir(), `sweep-${Math.random().toString(36).slice(2)}`);
    makeTurn(root, "sess-a", "turn-live");
    age(join(root, "sess-a", "turn-live"), 5);

    sweepOrphanDownloads(root, [{ browserSessionId: "sess-a", browserTurnId: "turn-live" }], Date.now());

    expect(existsSync(join(root, "sess-a", "turn-live"))).toBe(true);
    // 兄弟目录名互为前缀时(t1 vs t11)不得连带 keep 或连带删除
    const prefixSibling = makeTurn(root, "sess-a", "turn-live-extra");
    age(prefixSibling, 5);
    sweepOrphanDownloads(root, [{ browserSessionId: "sess-a", browserTurnId: "turn-live" }], Date.now());
    expect(existsSync(prefixSibling)).toBe(false);
    expect(existsSync(join(root, "sess-a", "turn-live"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("skips segments outside the safePartition shape and missing roots", () => {
    const root = join(tmpdir(), `sweep-${Math.random().toString(36).slice(2)}`);
    // 外来/越界形态目录一律跳过
    const foreign = makeTurn(root, "..", "evil");
    sweepOrphanDownloads(root, [], Date.now());
    expect(existsSync(foreign)).toBe(true);

    // 不存在的 root 静默返回
    expect(() => sweepOrphanDownloads(join(root, "does-not-exist"), [], Date.now())).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});
