import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import { createMemoryV2Store } from "./markdown-store";
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

    const migratedPath = join(root, "entries", readdirSync(join(root, "entries"))[0]!);
    const migrated = readFileSync(migratedPath, "utf-8");
    expect(migratedPath).not.toBe(note);
    expect(existsSync(note)).toBe(false);
    expect(migrated).toContain("id: lume-app-development");
    expect(migrated).toContain("semantic_role: state");
    expect(migrated).toContain("facets:");
    expect(migrated).toContain("# Lume 应用开发活动");
    rmSync(parent, { recursive: true, force: true });
  });

  test("converts short legacy entries with a generated memory filename", () => {
    const parent = mkdtempSync(join(tmpdir(), "lume-memory-migration-short-"));
    const root = join(parent, "memory");
    const note = join(root, "entries", "2026-07-28-mem_20260728150000_chrome_bridge.md");
    const body = "Chrome Bridge 已启用。\n";
    mkdirSync(dirname(note), { recursive: true });
    writeFileSync(note, body, "utf-8");

    migrateMemoryScopeRootIfNeeded(root, "workspace");

    const migrated = readFileSync(note, "utf-8");
    expect(migrated).toContain("id: mem_20260728150000_chrome_bridge");
    expect(migrated).toContain(body.trim());
    rmSync(parent, { recursive: true, force: true });
  });

  test("accepts Windows line endings in existing frontmatter", () => {
    const parent = mkdtempSync(join(tmpdir(), "lume-memory-migration-crlf-"));
    const root = join(parent, "memory");
    const note = join(root, "entries", "2026-07-28-mem_test.md");
    const source = `\uFEFF---\r\nid: mem_test\r\nkind: fact\r\nupdated: 2026-07-28T15:00:00.000Z\r\n---\r\n正文\r\n`;
    mkdirSync(dirname(note), { recursive: true });
    writeFileSync(note, source, "utf-8");

    migrateMemoryScopeRootIfNeeded(root, "workspace");

    expect(readFileSync(note, "utf-8")).toContain("id: mem_test");
    rmSync(parent, { recursive: true, force: true });
  });

  test("repairs generated entry ids in workspaces already marked as schema 3", () => {
    const parent = mkdtempSync(join(tmpdir(), "lume-memory-migration-v3-"));
    const root = join(parent, "memory");
    const entryPath = join(root, "entries", "2026-07-28-mem_existing.md");
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    mkdirSync(dirname(entryPath), { recursive: true });
    writeFileSync(join(root, ".memory-schema.json"), `${JSON.stringify({
      version: 3,
      migratedAt: "2026-07-28T15:00:00.000Z"
    }, null, 2)}\n`, "utf-8");
    writeFileSync(entryPath, `---\n${YAML.stringify({
      id: "2026-07-28-mem_existing",
      kind: "state",
      scope: "global",
      status: "active",
      created: "2026-07-28T15:00:00.000Z",
      updated: "2026-07-28T15:00:00.000Z",
      source: { type: "manual" },
      confidence: "medium",
      pinned: false,
      tags: ["legacy"]
    }).trimEnd()}\n---\n旧版迁移后的记忆\n`, "utf-8");

    try {
      process.env.LUME_CONFIG_DIR = parent;
      const marker = migrateMemoryScopeRootIfNeeded(root, "global");
      expect(marker.version).toBe(4);
      expect(readFileSync(entryPath, "utf-8")).toContain("id: mem_existing");

      const store = createMemoryV2Store();
      const updated = store.updateEntryStatus({ scope: "global", id: "mem_existing", status: "archived" });
      expect(updated.frontmatter.id).toBe("mem_existing");
      expect(updated.frontmatter.status).toBe("archived");
      expect(store.deleteEntry({ scope: "global", id: "mem_existing" })).toMatchObject({ ok: true, id: "mem_existing" });
      expect(existsSync(entryPath)).toBe(false);
    } finally {
      if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
      else process.env.LUME_CONFIG_DIR = previousConfigDir;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rewrites entry and pending references to repaired schema 3 ids", () => {
    const parent = mkdtempSync(join(tmpdir(), "lume-memory-migration-v3-refs-"));
    const root = join(parent, "memory");
    const entriesDir = join(root, "entries");
    const targetPath = join(entriesDir, "2026-07-28-mem_target.md");
    const relatedPath = join(entriesDir, "2026-07-28-mem_related.md");
    const pendingPath = join(root, "pending", "conflicts", "2026-07-28-pending_test.md");
    const capsulePath = join(root, "capsules", "legacy.md");
    const oldId = "2026-07-28-mem_target";
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    mkdirSync(entriesDir, { recursive: true });
    mkdirSync(dirname(pendingPath), { recursive: true });
    mkdirSync(dirname(capsulePath), { recursive: true });
    writeFileSync(join(root, ".memory-schema.json"), `${JSON.stringify({ version: 3, migratedAt: "2026-07-28T15:00:00.000Z" }, null, 2)}\n`, "utf-8");
    writeFileSync(targetPath, memoryEntrySource({ id: oldId, statement: "需要被替换的旧记忆" }), "utf-8");
    writeFileSync(relatedPath, memoryEntrySource({
      id: "mem_related",
      statement: "引用旧记忆的条目",
      related: [oldId],
      supersedes: [oldId],
      superseded_by: oldId
    }), "utf-8");
    writeFileSync(pendingPath, `---\n${YAML.stringify({
      id: "pending_test",
      type: "conflict",
      created: "2026-07-28T16:00:00.000Z",
      candidate: {
        kind: "state",
        targetScope: "global",
        statement: "替换后的新记忆",
        confidence: "high"
      },
      existing: { ids: [oldId] },
      reason: "测试迁移引用",
      status: "open"
    }).trimEnd()}\n---\n测试迁移引用\n`, "utf-8");
    writeFileSync(join(root, "MEMORY.md"), `- [${oldId}] 旧索引\n`, "utf-8");
    writeFileSync(capsulePath, `---\nclaim_ids:\n  - ${oldId}\n---\n旧主题摘要\n`, "utf-8");

    try {
      process.env.LUME_CONFIG_DIR = parent;
      migrateMemoryScopeRootIfNeeded(root, "global");

      const store = createMemoryV2Store();
      const related = store.listEntries({ scopes: ["global"] }).find((entry) => entry.frontmatter.id === "mem_related");
      expect(related?.frontmatter.related).toEqual(["mem_target"]);
      expect(related?.frontmatter.supersedes).toEqual(["mem_target"]);
      expect(related?.frontmatter.superseded_by).toBe("mem_target");
      const pending = store.listPending({ scopes: ["global"] })[0]!;
      expect(pending.frontmatter.existing?.ids).toEqual(["mem_target"]);
      expect(existsSync(join(root, "MEMORY.md"))).toBe(false);
      expect(existsSync(capsulePath)).toBe(false);

      store.resolvePending({ workspaceSlug: "unused", path: pending.path, action: "accept" });
      const target = store.listEntries({ scopes: ["global"], includeStatuses: ["superseded"] })
        .find((entry) => entry.frontmatter.id === "mem_target");
      expect(target?.frontmatter.status).toBe("superseded");
    } finally {
      if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
      else process.env.LUME_CONFIG_DIR = previousConfigDir;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

function memoryEntrySource(input: {
  id: string;
  statement: string;
  related?: string[];
  supersedes?: string[];
  superseded_by?: string | null;
}): string {
  return `---\n${YAML.stringify({
    id: input.id,
    kind: "state",
    scope: "global",
    status: "active",
    created: "2026-07-28T15:00:00.000Z",
    updated: "2026-07-28T15:00:00.000Z",
    source: { type: "manual" },
    confidence: "medium",
    pinned: false,
    tags: ["legacy"],
    related: input.related ?? [],
    supersedes: input.supersedes ?? [],
    superseded_by: input.superseded_by ?? null
  }).trimEnd()}\n---\n${input.statement}\n`;
}
