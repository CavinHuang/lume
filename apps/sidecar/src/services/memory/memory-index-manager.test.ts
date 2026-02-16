import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(stats.fileCount).toBeGreaterThanOrEqual(2);
    expect(stats.chunkCount).toBeGreaterThan(0);

    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  test("readFile 默认返回完整内容，且拒绝非记忆路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-read-"));
    const memoryDir = join(root, "memory");
    mkdirSync(memoryDir, { recursive: true });

    writeFileSync(join(root, "MEMORY.md"), "# Long Term\nline-2", "utf-8");
    writeFileSync(join(root, "notes.md"), "this should not be readable", "utf-8");

    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath: join(root, "default.sqlite")
    });

    await manager.indexWorkspace(true);

    const full = manager.readFile({ path: "MEMORY.md" });
    expect(full.text).toContain("# Long Term");
    expect(full.text).toContain("line-2");

    expect(() => manager.readFile({ path: "notes.md" })).toThrow("仅允许读取");

    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  test("indexWorkspace 应兼容 memory.md 作为长期记忆文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-alt-"));
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory.md"), "alt long-term memory text", "utf-8");

    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath: join(root, "default.sqlite")
    });

    await manager.indexWorkspace(true);
    const results = await manager.search({ query: "long-term memory", maxResults: 3 });
    expect(results.some((item) => item.path === "memory.md" || item.path === "MEMORY.md")).toBeTrue();

    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  test("indexWorkspace 应跳过符号链接的长期记忆文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-symlink-"));
    const external = mkdtempSync(join(tmpdir(), "lume-memory-external-"));
    writeFileSync(join(external, "external.md"), "should not be indexed by symlink", "utf-8");
    symlinkSync(join(external, "external.md"), join(root, "MEMORY.md"));

    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath: join(root, "default.sqlite")
    });

    await manager.indexWorkspace(true);
    const results = await manager.search({ query: "symlink", maxResults: 3 });
    expect(results.length).toBe(0);

    manager.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });

  test("indexFile 应跳过符号链接文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-indexfile-symlink-"));
    const external = mkdtempSync(join(tmpdir(), "lume-memory-indexfile-src-"));
    writeFileSync(join(external, "note.md"), "external", "utf-8");
    symlinkSync(join(external, "note.md"), join(root, "memory.md"));

    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath: join(root, "default.sqlite")
    });

    const indexed = await manager.indexFile("memory.md", true);
    expect(indexed).toBe(0);
    expect(manager.getStats().chunkCount).toBe(0);

    manager.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
});
