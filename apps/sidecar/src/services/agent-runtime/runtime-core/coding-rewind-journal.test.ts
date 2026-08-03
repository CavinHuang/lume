import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createCodingRewindJournal,
  listIncompleteCodingRewindJournals,
  updateCodingRewindJournal
} from "./coding-rewind-journal";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding rewind journal", () => {
  test("persists progress and leaves incomplete transactions discoverable", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "lume-coding-journal-"));
    temporaryDirectories.push(sessionDir);
    let journal = await createCodingRewindJournal({
      sessionDir,
      runId: "run-1",
      turnId: "turn-1",
      assistantMessageId: "assistant-1",
      files: ["src/a.ts"]
    });
    journal = await updateCodingRewindJournal(journal, {
      status: "partial",
      restoredFiles: ["src/a.ts"],
      conflicts: ["src/b.ts"]
    });

    const incomplete = await listIncompleteCodingRewindJournals(sessionDir);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({ status: "partial", conflicts: ["src/b.ts"] });
    const stored = await readFile(join(sessionDir, `coding-rewind-${journal.operationId}.json`), "utf8");
    expect(stored).not.toContain("sessionDir");
  });

  test("does not block on completed transactions", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "lume-coding-journal-"));
    temporaryDirectories.push(sessionDir);
    const journal = await createCodingRewindJournal({
      sessionDir,
      runId: "run-2",
      turnId: "turn-2",
      assistantMessageId: "assistant-2",
      files: []
    });
    await updateCodingRewindJournal(journal, { status: "completed", removedMessageCount: 2 });
    await expect(listIncompleteCodingRewindJournals(sessionDir)).resolves.toEqual([]);
  });

  test("surfaces a corrupt journal instead of silently ignoring recovery state", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "lume-coding-journal-"));
    temporaryDirectories.push(sessionDir);
    await writeFile(join(sessionDir, "coding-rewind-corrupt.json"), "{not-json", "utf8");

    await expect(listIncompleteCodingRewindJournals(sessionDir)).rejects.toThrow("回退日志损坏");
  });
});
