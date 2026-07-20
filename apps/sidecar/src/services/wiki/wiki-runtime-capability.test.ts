import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { advanceShellToolSelection, resolveVoltaNodeImages } from "./wiki-runtime-capability";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Wiki runtime capability", () => {
  test("falls through candidates and then skips an incompatible optional tool", () => {
    const selectedIndexes = [0, 0];
    const candidateCounts = [2, 1];

    expect(advanceShellToolSelection(selectedIndexes, candidateCounts, 0)).toBeTrue();
    expect(selectedIndexes).toEqual([1, 0]);
    expect(advanceShellToolSelection(selectedIndexes, candidateCounts, 0)).toBeTrue();
    expect(selectedIndexes).toEqual([2, 0]);
    expect(advanceShellToolSelection(selectedIndexes, candidateCounts, 0)).toBeFalse();
    expect(advanceShellToolSelection(selectedIndexes, candidateCounts, -1)).toBeFalse();
  });

  test("discovers real Volta Node images newest-first", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-volta-node-images-"));
    roots.push(root);
    for (const version of ["18.20.3", "24.1.0", "20.16.0"]) {
      const versionRoot = join(root, version);
      mkdirSync(versionRoot);
      writeFileSync(join(versionRoot, "node.exe"), "fixture");
    }

    expect(resolveVoltaNodeImages(root)).toEqual([
      resolve(root, "24.1.0", "node.exe"),
      resolve(root, "20.16.0", "node.exe"),
      resolve(root, "18.20.3", "node.exe")
    ]);
  });
});
