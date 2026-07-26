import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { FileCheckpoint } from "@lume/agent-sdk";
import {
  persistCodingRunCheckpoint,
  revertCodingRun,
} from "./coding-run-checkpoint-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding run checkpoints", () => {
  test("restores the pre-run contents and removes files created by the run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lume-coding-checkpoint-"));
    temporaryDirectories.push(cwd);
    const sessionDir = join(cwd, "session");
    const existingPath = join(cwd, "src", "existing.ts");
    const createdPath = join(cwd, "src", "created.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(existingPath, "before\n", "utf8");

    const checkpoint: FileCheckpoint = {
      userMessageId: "message-1",
      createdAt: new Date().toISOString(),
      files: {
        [existingPath]: { path: existingPath, existed: true, content: "before\n", encoding: "utf8", lineEnding: "LF" },
        [createdPath]: { path: createdPath, existed: false },
      },
    };
    await writeFile(existingPath, "after\n", "utf8");
    await writeFile(createdPath, "created\n", "utf8");
    expect(await persistCodingRunCheckpoint({ sessionDir, runId: "run-1", cwd, checkpoint })).toBe(true);
    const result = await revertCodingRun({ sessionDir, runId: "run-1" });

    expect(result.filesChanged).toEqual([existingPath, createdPath]);
    expect(await readFile(existingPath, "utf8")).toBe("before\n");
    await expect(readFile(createdPath, "utf8")).rejects.toThrow();
  });

  test("does not overwrite a file changed after the checkpoint was persisted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lume-coding-checkpoint-"));
    temporaryDirectories.push(cwd);
    const sessionDir = join(cwd, "session");
    const path = join(cwd, "src", "changed.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(path, "after\n", "utf8");
    const checkpoint: FileCheckpoint = {
      userMessageId: "message-1",
      createdAt: new Date().toISOString(),
      files: { [path]: { path, existed: true, content: "before\n", encoding: "utf8", lineEnding: "LF" } },
    };
    expect(await persistCodingRunCheckpoint({ sessionDir, runId: "run-conflict", cwd, checkpoint })).toBe(true);

    await writeFile(path, "external\n", "utf8");
    const result = await revertCodingRun({ sessionDir, runId: "run-conflict" });

    expect(result.status).toBe("conflict");
    expect(result.conflicts).toEqual([path]);
    expect(await readFile(path, "utf8")).toBe("external\n");
  });

  test("does not persist snapshots outside the workspace root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lume-coding-checkpoint-"));
    const outside = await mkdtemp(join(tmpdir(), "lume-coding-outside-"));
    temporaryDirectories.push(cwd, outside);
    const checkpoint: FileCheckpoint = {
      userMessageId: "message-1",
      createdAt: new Date().toISOString(),
      files: {
        [join(outside, "outside.ts")]: { path: join(outside, "outside.ts"), existed: true, content: "secret" },
      },
    };

    expect(await persistCodingRunCheckpoint({ sessionDir: join(cwd, "session"), runId: "run-2", cwd, checkpoint })).toBe(false);
  });
});
