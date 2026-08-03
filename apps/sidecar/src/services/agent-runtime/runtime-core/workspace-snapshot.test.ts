import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  flattenWorkspaceSnapshotDiff
} from "./workspace-snapshot";

describe("workspace snapshot", () => {
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
  });
});
