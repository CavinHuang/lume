import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveVoltaNodeImages } from "./wiki-runtime-capability";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Wiki runtime capability", () => {
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
