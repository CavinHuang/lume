import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryIndexManager } from "./memory-index-manager";

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
    rmSync(root, { recursive: true, force: true });
  });
});
