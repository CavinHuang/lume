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
});
