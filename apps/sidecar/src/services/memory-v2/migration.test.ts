import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import { MEMORY_SCHEMA_VERSION, migrateMemoryScopeRootIfNeeded } from "./migration";

describe("memory schema migration", () => {
  test("backs up, maps legacy fields, removes derived persona and is idempotent", () => {
    const parent = mkdtempSync(join(tmpdir(), "lume-memory-migration-"));
    const root = join(parent, "memory");
    const entryPath = join(root, "entries", "2026-01-01-mem_test.md");
    mkdirSync(dirname(entryPath), { recursive: true });
    writeFileSync(join(root, "persona.md"), "# stale persona\n", "utf-8");
    writeFileSync(entryPath, `---\n${YAML.stringify({
      id: "mem_test",
      kind: "preference",
      scope: "global",
      status: "active",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: { type: "manual" },
      confidence: "high",
      pinned: false,
      tags: ["voice"]
    }).trimEnd()}\n---\n默认使用中文回答\n`, "utf-8");

    const first = migrateMemoryScopeRootIfNeeded(root, "global");
    expect(first.version).toBe(MEMORY_SCHEMA_VERSION);
    expect(first.backupPath && existsSync(first.backupPath)).toBe(true);
    expect(existsSync(join(root, "persona.md"))).toBe(false);
    const migrated = readFileSync(entryPath, "utf-8");
    expect(migrated).toContain("semantic_role: preference");
    expect(migrated).toContain("revision: 1");
    expect(migrateMemoryScopeRootIfNeeded(root, "global")).toEqual(first);
    rmSync(parent, { recursive: true, force: true });
  });

  test("keeps the original scope intact when one legacy entry is damaged", () => {
    const parent = mkdtempSync(join(tmpdir(), "lume-memory-migration-bad-"));
    const root = join(parent, "memory");
    const bad = join(root, "entries", "bad.md");
    mkdirSync(dirname(bad), { recursive: true });
    writeFileSync(bad, "not frontmatter", "utf-8");
    expect(() => migrateMemoryScopeRootIfNeeded(root, "workspace")).toThrow("Missing frontmatter");
    expect(readFileSync(bad, "utf-8")).toBe("not frontmatter");
    rmSync(parent, { recursive: true, force: true });
  });

  test("converts heading-led legacy Markdown notes without losing their body", () => {
    const parent = mkdtempSync(join(tmpdir(), "lume-memory-migration-note-"));
    const root = join(parent, "memory");
    const note = join(root, "entries", "lume-app-development.md");
    const body = `# Lume 应用开发活动\n\n这是一个旧版连续性笔记，记录已经确认的项目背景和协作约束。\n\n## 主题定制\n\n后续工作继续维护该项目。\n`;
    mkdirSync(dirname(note), { recursive: true });
    writeFileSync(note, body, "utf-8");

    migrateMemoryScopeRootIfNeeded(root, "workspace");

    const migrated = readFileSync(note, "utf-8");
    expect(migrated).toContain("id: lume-app-development");
    expect(migrated).toContain("semantic_role: state");
    expect(migrated).toContain("facets:");
    expect(migrated).toContain("# Lume 应用开发活动");
    rmSync(parent, { recursive: true, force: true });
  });
});
