import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryIndexManager } from "./memory-index-manager";

function removeDirWithRetry(path: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

describe("memory-save", () => {
  test("saveMemory 应写入 memory/YYYY-MM-DD.md 并可检索", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-save-"));
    const dbPath = join(root, "default.sqlite");
    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath
    });

    const saved = await manager.saveMemory({
      content: "User prefers concise technical answers.",
      date: "2026-02-12"
    });

    expect(saved.path).toBe("memory/2026-02-12.md");
    expect(saved.bytes).toBeGreaterThan(0);

    const result = await manager.search({ query: "concise technical", maxResults: 3 });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.path).toBe("memory/2026-02-12.md");

    manager.dispose();
    removeDirWithRetry(root);
  });

  test("saveMemory 应同步写入结构化 memory item", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-save-"));
    const dbPath = join(root, "default.sqlite");
    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath
    });

    const saved = await manager.saveMemory({
      content: "The memory settings page should expose audit history.",
      date: "2026-04-26",
      scope: "workspace",
      kind: "decision",
      source: "manual",
      title: "Expose memory audit",
      tags: ["memory", "settings"],
      importance: 4,
      confidence: 0.8,
      sourceSessionId: "session-1",
      sourceMessageIds: ["msg-1"]
    });

    expect(saved.path).toBe("memory/2026-04-26.md");
    expect(saved.itemId).toBeTruthy();

    const result = await manager.search({
      query: "audit history",
      maxResults: 3,
      kinds: ["decision"],
      scopes: ["workspace"]
    });
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: saved.itemId,
        kind: "decision",
        scope: "workspace",
        source: "manual"
      })
    );

    manager.dispose();
    removeDirWithRetry(root);
  });
});
