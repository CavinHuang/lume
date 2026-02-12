import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryIndexManager } from "./memory-index-manager";

describe("memory-index-manager", () => {
  test("应索引工作区并可通过关键词搜索命中", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-"));
    const memoryDir = join(root, "memory");
    mkdirSync(memoryDir, { recursive: true });

    writeFileSync(join(root, "MEMORY.md"), "# Preferences\nI like sqlite and markdown-first design.", "utf-8");
    writeFileSync(join(memoryDir, "2026-02-12.md"), "Discussed hybrid search and BM25 ranking.", "utf-8");

    const dbPath = join(root, "default.sqlite");
    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath
    });

    const indexed = await manager.indexWorkspace(true);
    expect(indexed).toBeGreaterThan(0);

    const results = await manager.search({ query: "hybrid search", maxResults: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/");
    expect(results[0]?.snippet.length).toBeGreaterThan(0);
    expect(results[0]?.citation).toContain("#L");

    const memoryContent = manager.readFile({ path: "MEMORY.md", from: 1, lines: 2 });
    expect(memoryContent.path).toBe("MEMORY.md");
    expect(memoryContent.text).toContain("Preferences");

    const semantic = await manager.search({
      query: "记忆 系统",
      maxResults: 3,
      queryEmbedding: [1, 0, 0]
    });
    // 仅验证路径流程无异常；真实语义排序由 query embedding 决定。
    expect(Array.isArray(semantic)).toBeTrue();

    const stats = manager.getStats();
    expect(stats.workspaceSlug).toBe("default");
    expect(stats.fileCount).toBe(2);
    expect(stats.chunkCount).toBeGreaterThan(0);

    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});
