import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  flattenWorkspaceSnapshotDiff
} from "./workspace-snapshot";

describe("workspace snapshot", () => {
  // 真实 spawn git 枚举：bun 运行时前两次子进程调用有秒级 warmup，放宽单测超时。
  test("captures additions, modifications and deletions while excluding generated directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-workspace-snapshot-"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "a.ts"), "one");
    writeFileSync(join(root, "node_modules", "ignored.js"), "ignored");
    const before = await captureWorkspaceSnapshot(root);

    writeFileSync(join(root, "a.ts"), "two");
    writeFileSync(join(root, "b.ts"), "new");
    rmSync(join(root, "a.ts"));
    const after = await captureWorkspaceSnapshot(root);
    const diff = diffWorkspaceSnapshots(before, after);

    expect(Object.keys(before.files)).toEqual(["a.ts"]);
    expect(diff.added).toEqual(["b.ts"]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual(["a.ts"]);
    expect(flattenWorkspaceSnapshotDiff(diff)).toEqual(["b.ts", "a.ts"]);
  }, 20_000);

  test("respects .gitignore in git repositories and skips generated directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-workspace-snapshot-git-"));
    execSync("git init -q", { cwd: root });
    writeFileSync(join(root, ".gitignore"), "ignored/\nnode_modules/\ntarget/\n");
    mkdirSync(join(root, "ignored"));
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "tracked.ts"), "one");
    writeFileSync(join(root, "ignored", "junk.ts"), "junk");
    writeFileSync(join(root, "node_modules", "dep.js"), "dep");
    writeFileSync(join(root, "target", "lib.rlib"), "binary");
    writeFileSync(join(root, "untracked.ts"), "untracked");

    const snapshot = await captureWorkspaceSnapshot(root);

    expect(Object.keys(snapshot.files).sort()).toEqual([".gitignore", "tracked.ts", "untracked.ts"]);
  }, 20_000);

  test("detects modified files via stat metadata without reading file contents", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-workspace-snapshot-stat-"));
    writeFileSync(join(root, "a.ts"), "one");
    const before = await captureWorkspaceSnapshot(root);

    writeFileSync(join(root, "a.ts"), "completely different content");
    const after = await captureWorkspaceSnapshot(root);

    expect(diffWorkspaceSnapshots(before, after).modified).toEqual(["a.ts"]);
  });
});
