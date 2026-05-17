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
});
