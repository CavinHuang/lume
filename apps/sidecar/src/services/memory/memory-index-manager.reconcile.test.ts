import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryIndexManager } from "./memory-index-manager";

describe("memory-index-manager reconcile", () => {
  test("indexWorkspace 应清理已删除文件的索引", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-reconcile-"));
    const memoryDir = join(root, "memory");
    mkdirSync(memoryDir, { recursive: true });

    const dayFile = join(memoryDir, "2026-02-12.md");
    writeFileSync(join(root, "MEMORY.md"), "long term", "utf-8");
    writeFileSync(dayFile, "temp record", "utf-8");

    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath: join(root, "default.sqlite")
    });

    await manager.indexWorkspace(true);
    expect(manager.getStats().fileCount).toBe(2);

    unlinkSync(dayFile);
    await manager.indexWorkspace(false);
    expect(manager.getStats().fileCount).toBe(1);

    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});
