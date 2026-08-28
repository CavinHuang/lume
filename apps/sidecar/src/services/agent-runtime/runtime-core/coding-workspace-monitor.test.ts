import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCodingWorkspaceMonitor } from "./coding-workspace-monitor";

describe("coding workspace monitor", () => {
  test("ignores SDK atomic-write temp paths without hiding ordinary tmp files", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-monitor-"));
    const monitor = createCodingWorkspaceMonitor([root]);
    try {
      const target = join(root, "autumn-poem-card.html");
      const atomicTemp = join(root, ".autumn-poem-card.html.cb073940-acb8-4c86-a3f5-e5f6ccbc6323.tmp");
      const ordinaryTemp = join(root, "notes.tmp");

      monitor.recordAttributedPath(atomicTemp);
      monitor.recordAttributedPath(target);
      monitor.recordAttributedPath(ordinaryTemp);

      expect(monitor.getAttributedPaths()).toEqual([
        resolve(target),
        resolve(ordinaryTemp),
      ]);
    } finally {
      monitor.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
