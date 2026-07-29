import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { FileCheckpoint } from "@lume/agent-sdk";
import {
  getCodingFileDiffFromCheckpoint,
  loadCodingRunCheckpoint,
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

  test("loads a historical diff from the run snapshots after the workspace changes again", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lume-coding-checkpoint-"));
    temporaryDirectories.push(cwd);
    const sessionDir = join(cwd, "session");
    const path = join(cwd, "src", "changed.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    const checkpoint: FileCheckpoint = {
      userMessageId: "message-1",
      createdAt: new Date().toISOString(),
      files: { [path]: { path, existed: true, content: "before\n", encoding: "utf8", lineEnding: "LF" } },
    };
    await writeFile(path, "after\n", "utf8");
    await persistCodingRunCheckpoint({
      sessionDir,
      runId: "run-diff",
      cwd,
      changedPaths: ["src/changed.ts"],
      checkpoint,
    });
    await writeFile(path, "later\n", "utf8");

    await expect(getCodingFileDiffFromCheckpoint({
      sessionDir,
      runId: "run-diff",
      path: "src/changed.ts",
    })).resolves.toMatchObject({
      path: "src/changed.ts",
      oldContent: "before\n",
      newContent: "after\n",
      addedLines: 1,
      removedLines: 1,
    });
  });

  test("precomputes separated edits once and preserves unchanged lines between them", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lume-coding-checkpoint-"));
    temporaryDirectories.push(cwd);
    const sessionDir = join(cwd, "session");
    const path = join(cwd, "src", "changed.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    const before = "one\nold-a\nmiddle\nold-b\nlast\n";
    const after = "one\nnew-a\nmiddle\nnew-b\nlast\n";
    await writeFile(path, after, "utf8");

    await persistCodingRunCheckpoint({
      sessionDir,
      runId: "run-precomputed-diff",
      cwd,
      changedPaths: ["src/changed.ts"],
      checkpoint: {
        userMessageId: "message-1",
        createdAt: new Date().toISOString(),
        files: { [path]: { path, existed: true, content: before, encoding: "utf8", lineEnding: "LF" } },
      },
    });

    const record = await loadCodingRunCheckpoint({ sessionDir, runId: "run-precomputed-diff" });
    expect(record?.diffs?.[path]?.lines).toContainEqual({
      type: "context",
      oldLine: 3,
      newLine: 3,
      text: "middle",
    });
    await expect(getCodingFileDiffFromCheckpoint({
      sessionDir,
      runId: "run-precomputed-diff",
      path: "src/changed.ts",
    })).resolves.toMatchObject({
      addedLines: 2,
      removedLines: 2,
    });
  });

  test("recovers an unsupported legacy before snapshot from the baseline commit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lume-coding-checkpoint-"));
    temporaryDirectories.push(cwd);
    const sessionDir = join(cwd, "session");
    const path = join(cwd, "src", "changed.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(path, "before\n", "utf8");
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "user.email", "lume@example.test"]);
    runGit(cwd, ["config", "user.name", "Lume Test"]);
    runGit(cwd, ["add", "src/changed.ts"]);
    runGit(cwd, ["commit", "-m", "baseline"]);
    const baselineCommit = runGit(cwd, ["rev-parse", "HEAD"]);
    await writeFile(path, "after\n", "utf8");

    await persistCodingRunCheckpoint({
      sessionDir,
      runId: "legacy-run",
      cwd,
      baselineCommit,
      checkpoint: {
        userMessageId: "message-1",
        createdAt: new Date().toISOString(),
        files: { [path]: { path, existed: true, unsupported: true } },
      },
    });

    await expect(getCodingFileDiffFromCheckpoint({
      sessionDir,
      runId: "legacy-run",
      path: "src/changed.ts",
    })).resolves.toMatchObject({
      oldContent: "before\n",
      newContent: "after\n",
      addedLines: 1,
      removedLines: 1,
    });
  }, 30_000);

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

  test("restores rewindable repositories while preserving files across a committed boundary", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "lume-coding-repo-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "lume-coding-repo-b-"));
    temporaryDirectories.push(firstRoot, secondRoot);
    const firstPath = join(firstRoot, "file.ts");
    const secondPath = join(secondRoot, "file.ts");
    for (const root of [firstRoot, secondRoot]) {
      runGit(root, ["init"]);
      runGit(root, ["config", "user.email", "lume@example.test"]);
      runGit(root, ["config", "user.name", "Lume Test"]);
    }
    await writeFile(firstPath, "before-a\n", "utf8");
    await writeFile(secondPath, "before-b\n", "utf8");
    runGit(firstRoot, ["add", "file.ts"]);
    runGit(firstRoot, ["commit", "-m", "baseline"]);
    runGit(secondRoot, ["add", "file.ts"]);
    runGit(secondRoot, ["commit", "-m", "baseline"]);
    const firstBaseline = runGit(firstRoot, ["rev-parse", "HEAD"]);
    const secondBaseline = runGit(secondRoot, ["rev-parse", "HEAD"]);

    await writeFile(firstPath, "after-a\n", "utf8");
    await writeFile(secondPath, "after-b\n", "utf8");
    const sessionDir = join(firstRoot, "session");
    await persistCodingRunCheckpoint({
      sessionDir,
      runId: "multi-repo-run",
      cwd: firstRoot,
      roots: [secondRoot],
      baselineCommit: firstBaseline,
      baselineCommits: {
        [firstRoot]: firstBaseline,
        [secondRoot]: secondBaseline,
      },
      checkpoint: {
        userMessageId: "message-1",
        createdAt: new Date().toISOString(),
        files: {
          [firstPath]: { path: firstPath, existed: true, content: "before-a\n", encoding: "utf8", lineEnding: "LF" },
          [secondPath]: { path: secondPath, existed: true, content: "before-b\n", encoding: "utf8", lineEnding: "LF" },
        },
      },
    });
    runGit(secondRoot, ["add", "file.ts"]);
    runGit(secondRoot, ["commit", "-m", "turn commit"]);

    const result = await revertCodingRun({ sessionDir, runId: "multi-repo-run" });

    expect(result.status).toBe("committed_boundary");
    expect(result.filesChanged).toEqual([firstPath]);
    expect(result.nonRewindableFiles).toContain(secondPath);
    expect(await readFile(firstPath, "utf8")).toBe("before-a\n");
    expect(await readFile(secondPath, "utf8")).toBe("after-b\n");
  }, 30_000);

  test("resumes a partially applied file rewind without treating restored files as conflicts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lume-coding-resumable-rewind-"));
    temporaryDirectories.push(cwd);
    const firstPath = join(cwd, "first.ts");
    const secondPath = join(cwd, "second.ts");
    await writeFile(firstPath, "after-first\n", "utf8");
    await writeFile(secondPath, "after-second\n", "utf8");
    const sessionDir = join(cwd, "session");
    await persistCodingRunCheckpoint({
      sessionDir,
      runId: "resumable-run",
      cwd,
      checkpoint: {
        userMessageId: "message-1",
        createdAt: new Date().toISOString(),
        files: {
          [firstPath]: { path: firstPath, existed: true, content: "before-first\n", encoding: "utf8", lineEnding: "LF" },
          [secondPath]: { path: secondPath, existed: true, content: "before-second\n", encoding: "utf8", lineEnding: "LF" },
        },
      },
    });

    await expect(revertCodingRun({
      sessionDir,
      runId: "resumable-run",
      onFileRestored: async () => {
        throw new Error("simulated journal interruption");
      },
    })).rejects.toThrow("simulated journal interruption");
    expect(await readFile(firstPath, "utf8")).toBe("before-first\n");
    expect(await readFile(secondPath, "utf8")).toBe("after-second\n");

    const resumed = await revertCodingRun({ sessionDir, runId: "resumable-run" });

    expect(resumed.status).toBe("restored");
    expect(resumed.filesChanged).toEqual([firstPath, secondPath]);
    expect(await readFile(secondPath, "utf8")).toBe("before-second\n");
  });
});

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}
