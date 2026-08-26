import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createFileAccessLedger } from "./file-access-ledger";

describe("file access ledger", () => {
  test("requires a full fresh read before overwriting an existing file", async () => {
    const root = join(tmpdir(), `lume-ledger-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "before", "utf-8");

    const ledger = createFileAccessLedger();
    await expect(ledger.assertCanOverwrite({
      threadId: "thread-1",
      cwd: root,
      filePath
    })).resolves.toMatchObject({ ok: false, reason: "not_read" });

    const fileStat = await stat(filePath);
    ledger.recordRead({
      threadId: "thread-1",
      cwd: root,
      filePath,
      mtimeMs: fileStat.mtimeMs,
      fullRead: true
    });
    await expect(ledger.assertCanOverwrite({
      threadId: "thread-1",
      cwd: root,
      filePath
    })).resolves.toEqual({ ok: true });

    await writeFile(filePath, "changed elsewhere", "utf-8");
    await expect(ledger.assertCanOverwrite({
      threadId: "thread-1",
      cwd: root,
      filePath
    })).resolves.toMatchObject({ ok: false, reason: "stale" });
    expect(await readFile(filePath, "utf-8")).toBe("changed elsewhere");
  });

  test("rejects overwrites after partial reads", async () => {
    const root = join(tmpdir(), `lume-ledger-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "line1\nline2\nline3", "utf-8");
    const fileStat = await stat(filePath);

    const ledger = createFileAccessLedger();
    ledger.recordRead({
      threadId: "thread-1",
      cwd: root,
      filePath,
      mtimeMs: fileStat.mtimeMs,
      fullRead: false
    });

    await expect(ledger.assertCanOverwrite({
      threadId: "thread-1",
      cwd: root,
      filePath
    })).resolves.toMatchObject({ ok: false, reason: "partial_read" });
  });

  test("clears read records by thread", async () => {
    const root = join(tmpdir(), `lume-ledger-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "before", "utf-8");
    const fileStat = await stat(filePath);

    const ledger = createFileAccessLedger();
    ledger.recordRead({
      threadId: "thread-1",
      cwd: root,
      filePath,
      mtimeMs: fileStat.mtimeMs,
      fullRead: true
    });
    ledger.clearThread("thread-1");

    await expect(ledger.assertCanOverwrite({
      threadId: "thread-1",
      cwd: root,
      filePath
    })).resolves.toMatchObject({ ok: false, reason: "not_read" });
  });

  test("#649 follow-up: 大小写不同的同一路径命中同一台账键（win32/darwin）", async () => {
    const root = join(tmpdir(), `lume-ledger-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "CaseSensitive.txt");
    await writeFile(filePath, "before", "utf-8");
    const fileStat = await stat(filePath);

    const ledger = createFileAccessLedger();
    ledger.recordRead({
      threadId: "thread-1",
      cwd: root.toUpperCase(),
      filePath: filePath.toUpperCase(),
      mtimeMs: fileStat.mtimeMs,
      fullRead: true
    });

    // Read 用大写路径登记，Edit 用小写路径写入——归一前台账 miss 误报「必须先完整读取」。
    // 大小写不敏感平台(win32/darwin):归一后同键,放行。
    if (process.platform === "win32" || process.platform === "darwin") {
      await expect(ledger.assertCanOverwrite({
        threadId: "thread-1",
        cwd: root.toLowerCase(),
        filePath: filePath.toLowerCase()
      })).resolves.toEqual({ ok: true });
    } else {
      // #649 round3 Linux 断言补集:大小写敏感 FS 上两路径是不同文件,
      // 归一化若被误改为无条件 toLowerCase 会跨文件放行——必须保持 not_read
      await expect(ledger.assertCanOverwrite({
        threadId: "thread-1",
        cwd: root.toLowerCase(),
        filePath: filePath.toLowerCase()
      })).resolves.toMatchObject({ ok: false });
    }
  });
});
