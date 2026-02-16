import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectWorkspaceMemoryEntries, pruneStaleIndexedRows } from "./sync-ops";

describe("sync-ops", () => {
  test("collectWorkspaceMemoryEntries 应收集 memory 文件并跳过 symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-syncops-"));
    const external = mkdtempSync(join(tmpdir(), "lume-syncops-src-"));
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "MEMORY.md"), "main", "utf-8");
    writeFileSync(join(root, "memory", "2026-02-15.md"), "daily", "utf-8");
    writeFileSync(join(external, "x.md"), "external", "utf-8");
    symlinkSync(join(external, "x.md"), join(root, "memory", "linked.md"));

    const entries = collectWorkspaceMemoryEntries({ workspaceRoot: root, extraPaths: [] });
    const paths = entries.map((e) => e.logicalPath);

    expect(paths).toContain("MEMORY.md");
    expect(paths).toContain("memory/2026-02-15.md");
    expect(paths).not.toContain("memory/linked.md");

    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });

  test("pruneStaleIndexedRows 应删除不在 target 中的索引", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        source TEXT NOT NULL
      );
    `);
    db.query("INSERT INTO files (path, workspace_slug, source) VALUES (?1, ?2, ?3)").run("MEMORY.md", "ws", "memory");
    db.query("INSERT INTO files (path, workspace_slug, source) VALUES (?1, ?2, ?3)").run("memory/old.md", "ws", "memory");

    const deleted: string[] = [];
    pruneStaleIndexedRows({
      db,
      workspaceSlug: "ws",
      targetPaths: new Set(["MEMORY.md"]),
      onDeletePath: (path) => deleted.push(path)
    });

    const rows = db.query("SELECT path FROM files WHERE workspace_slug = ?1").all("ws") as Array<{ path: string }>;
    expect(rows.map((r) => r.path)).toEqual(["MEMORY.md"]);
    expect(deleted).toEqual(["memory/old.md"]);

    db.close();
  });
});
