import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReadingLibraryPath } from "../infra/config-paths";
import { addReadingBook, autoPickNextBook } from "./reading-store";

/**
 * 回归：autoPickNextBook 旧实现把 queued 书也算作 active（filter status !== "finished"），
 * 导致只要存在 queued 书就提前 return null —— queued 书永远无法被晋升为 reading，
 * 「推荐入队」链路形同虚设。修复后 activeBooks 只计 reading/paused，queued 可被正常晋升。
 */
describe("autoPickNextBook", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-pick-next-"));
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

  /** 把指定 title 的书的 updatedAt 改为 ts（用于绕过/触发 2 天冷却） */
  function patchUpdatedAt(title: string, ts: number): void {
    const path = getReadingLibraryPath();
    const library = JSON.parse(readFileSync(path, "utf-8"));
    for (const book of library.books ?? []) {
      if (book.title === title) book.updatedAt = ts;
    }
    writeFileSync(path, JSON.stringify(library, null, 2), "utf-8");
  }

  test("全 finished 且有 queued 书时，应晋升 queued 书为 reading", () => {
    const longAgo = Date.now() - 10 * 86400_000; // 10 天前，超过 2 天冷却
    addReadingBook({ title: "已读完甲", author: "X", track: "lume", status: "finished" });
    patchUpdatedAt("已读完甲", longAgo);
    addReadingBook({ title: "待读乙", author: "Y", track: "lume", status: "queued" });

    const next = autoPickNextBook();
    // 修复前：queued 被算作 active → 返回 null；修复后：返回待读乙并置为 reading
    expect(next).not.toBeNull();
    expect(next?.title).toBe("待读乙");
    expect(next?.status).toBe("reading");
  });

  test("仍有 reading 书时不晋升 queued（不抢读）", () => {
    addReadingBook({ title: "在读甲", author: "X", track: "lume", status: "reading" });
    addReadingBook({ title: "待读乙", author: "Y", track: "lume", status: "queued" });
    expect(autoPickNextBook()).toBeNull();
  });
});
