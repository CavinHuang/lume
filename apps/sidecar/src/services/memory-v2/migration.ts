import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import type { MemoryV2Scope } from "./types";

export const MEMORY_SCHEMA_VERSION = 4;
const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const GENERATED_MEMORY_FILENAME_RE = /^\d{4}-\d{2}-\d{2}-(mem_[A-Za-z0-9][A-Za-z0-9_-]*)\.md$/;

interface MemorySchemaMarker {
  version: number;
  migratedAt: string;
  backupPath?: string;
}

export function migrateMemoryScopeRootIfNeeded(root: string, scope: MemoryV2Scope): MemorySchemaMarker {
  const markerPath = join(root, ".memory-schema.json");
  const current = readMarker(markerPath);
  if (current?.version === MEMORY_SCHEMA_VERSION) return current;

  if (!existsSync(root) || readdirSync(root).length === 0) {
    mkdirSync(root, { recursive: true });
    const marker = { version: MEMORY_SCHEMA_VERSION, migratedAt: new Date().toISOString() };
    writeJson(markerPath, marker);
    return marker;
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const parent = dirname(root);
  const name = basename(root);
  const lockPath = join(parent, `.${name}.migration.lock`);
  const backupPath = join(parent, `${name}.backup-${stamp}`);
  const tempPath = join(parent, `.${name}.migration-${stamp}`);
  const previousPath = join(parent, `.${name}.previous-${stamp}`);
  let lockAcquired = false;

  try {
    const lockFd = openMigrationLock(lockPath);
    lockAcquired = true;
    try {
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");
    } finally {
      closeSync(lockFd);
    }
    cpSync(root, backupPath, { recursive: true, errorOnExist: true });
    cpSync(root, tempPath, { recursive: true, errorOnExist: true });
    const idMap = migrateEntries(tempPath, scope);
    migratePendingReferences(tempPath, idMap);
    invalidateIdDerivedViews(tempPath, idMap);
    rmSync(join(tempPath, "persona.md"), { force: true });
    validateEntries(tempPath);
    const marker: MemorySchemaMarker = {
      version: MEMORY_SCHEMA_VERSION,
      migratedAt: new Date().toISOString(),
      backupPath
    };
    writeJson(join(tempPath, ".memory-schema.json"), marker);
    renameSync(root, previousPath);
    try {
      renameSync(tempPath, root);
      rmSync(previousPath, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      renameSync(previousPath, root);
      throw error;
    }
    return marker;
  } catch (error) {
    rmSync(tempPath, { recursive: true, force: true });
    throw new Error(`Memory migration failed for ${scope}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (lockAcquired && existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function openMigrationLock(path: string): number {
  try {
    return openSync(path, "wx");
  } catch (error) {
    let owner: { pid?: unknown };
    try {
      owner = JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown };
    } catch {
      throw error;
    }
    if (typeof owner.pid !== "number") throw error;
    try {
      process.kill(owner.pid, 0);
      throw error;
    } catch (probeError) {
      if (probeError === error) throw error;
      try { unlinkSync(path); } catch { throw error; }
    }
    return openSync(path, "wx");
  }
}

function migrateEntries(root: string, scope: MemoryV2Scope): Map<string, string> {
  const entriesDir = join(root, "entries");
  const idMap = new Map<string, string>();
  if (!existsSync(entriesDir)) return idMap;
  const entries = listFiles(entriesDir, ".md").map((path) => ({ path, document: parseDocument(path, scope) }));
  for (const { path, document } of entries) {
    const previousId = typeof document.frontmatter.id === "string" ? document.frontmatter.id : undefined;
    const id = canonicalEntryId(path, previousId);
    if (previousId && previousId !== id) idMap.set(previousId, id);
  }
  for (const { path, document } of entries) {
    const now = typeof document.frontmatter.updated === "string"
      ? document.frontmatter.updated
      : new Date().toISOString();
    const tags = stringList(document.frontmatter.tags);
    const kind = normalizeKind(document.frontmatter.kind);
    const id = canonicalEntryId(path, document.frontmatter.id);
    const frontmatter = {
      ...document.frontmatter,
      id,
      kind,
      scope,
      semantic_role: inferRole(kind, tags),
      facets: stringList(document.frontmatter.facets ?? tags),
      related: rewriteReferenceList(document.frontmatter.related, idMap),
      supersedes: rewriteReferenceList(document.frontmatter.supersedes, idMap),
      superseded_by: rewriteReference(document.frontmatter.superseded_by, idMap),
      revision: positiveInteger(document.frontmatter.revision, 1),
      last_confirmed_at: document.frontmatter.last_confirmed_at ?? now,
      evidence_refs: Array.isArray(document.frontmatter.evidence_refs)
        ? document.frontmatter.evidence_refs
        : evidenceFromLegacySource(document.frontmatter.source)
    };
    const targetPath = canonicalEntryPath(path, id, document.frontmatter.created);
    if (targetPath !== path && existsSync(targetPath)) {
      throw new Error(`Duplicate migrated entry: ${targetPath}`);
    }
    writeDocument(targetPath, frontmatter, document.body);
    if (targetPath !== path) unlinkSync(path);
  }
  return idMap;
}

function migratePendingReferences(root: string, idMap: Map<string, string>): void {
  const pendingRoot = join(root, "pending");
  for (const type of ["conflicts", "stale", "low-confidence"]) {
    const dir = join(pendingRoot, type);
    if (!existsSync(dir)) continue;
    for (const path of listFiles(dir, ".md")) {
      const document = parseDocument(path);
      const existing = document.frontmatter.existing;
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) continue;
      const ids = rewriteReferenceList((existing as Record<string, unknown>).ids, idMap);
      writeDocument(path, {
        ...document.frontmatter,
        existing: ids.length > 0 ? { ...(existing as Record<string, unknown>), ids } : undefined
      }, document.body);
    }
  }
}

function invalidateIdDerivedViews(root: string, idMap: Map<string, string>): void {
  if (idMap.size === 0) return;
  rmSync(join(root, "MEMORY.md"), { force: true });
  rmSync(join(root, "capsules"), { recursive: true, force: true });
}

function validateEntries(root: string): void {
  const entriesDir = join(root, "entries");
  if (!existsSync(entriesDir)) return;
  for (const path of listFiles(entriesDir, ".md")) {
    const { frontmatter, body } = parseDocument(path);
    if (!frontmatter.id || !frontmatter.scope || !frontmatter.semantic_role || !positiveInteger(frontmatter.revision, 0) || !body.trim()) {
      throw new Error(`Invalid migrated entry: ${path}`);
    }
  }
}

function parseDocument(path: string, scope?: MemoryV2Scope): { frontmatter: Record<string, unknown>; body: string } {
  const source = readFileSync(path, "utf-8");
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    if (scope && isLegacyMarkdownNote(path, source)) {
      return legacyMarkdownDocument(path, source, scope);
    }
    throw new Error(`Missing frontmatter: ${path}`);
  }
  const frontmatter = YAML.parse(match[1] ?? "") as unknown;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw new Error(`Invalid frontmatter: ${path}`);
  return { frontmatter: frontmatter as Record<string, unknown>, body: source.slice(match[0].length) };
}

/**
 * Older workspaces occasionally stored durable Markdown notes directly under
 * entries/. Heading-led notes and non-empty files with the generated memory
 * filename are migrated; unrelated plain text still fails atomically.
 */
function isLegacyMarkdownNote(path: string, source: string): boolean {
  const trimmed = source.trimStart();
  const isHeadingLedNote = /^#{1,6}\s+\S+/.test(trimmed) && trimmed.includes("\n") && trimmed.trim().length >= 64;
  const hasGeneratedFilename = GENERATED_MEMORY_FILENAME_RE.test(basename(path));
  return isHeadingLedNote || (hasGeneratedFilename && Boolean(trimmed.trim()) && !trimmed.startsWith("---"));
}

function legacyMarkdownDocument(path: string, source: string, scope: MemoryV2Scope): { frontmatter: Record<string, unknown>; body: string } {
  const timestamp = statSync(path).mtime.toISOString();
  const filename = basename(path);
  const id = filename.match(GENERATED_MEMORY_FILENAME_RE)?.[1] ?? basename(path, ".md");
  return {
    frontmatter: {
      id,
      kind: "state",
      semantic_role: "state",
      facets: ["legacy", "history"],
      scope,
      status: "active",
      created: timestamp,
      updated: timestamp,
      last_confirmed_at: timestamp,
      revision: 1,
      source: { type: "manual" },
      confidence: "medium",
      pinned: false,
      tags: ["legacy", "history"],
      entities: [],
      related: [],
      supersedes: [],
      superseded_by: null,
      applies_when: {},
      valid_from: null,
      valid_to: null,
      activation: { recall: true, persona: true, suggestion: true, analyst: true },
      evidence_refs: [{ type: "manual" }]
    },
    body: source
  };
}

function canonicalEntryId(path: string, value: unknown): string {
  const generatedId = basename(path).match(GENERATED_MEMORY_FILENAME_RE)?.[1];
  if (generatedId) return generatedId;
  if (typeof value === "string" && value.trim() && !/[\\/]/.test(value)) return value.trim();
  return basename(path, ".md");
}

function canonicalEntryPath(path: string, id: string, created: unknown): string {
  if (GENERATED_MEMORY_FILENAME_RE.test(basename(path))) return path;
  const createdDate = typeof created === "string" ? created.match(/^\d{4}-\d{2}-\d{2}/)?.[0] : undefined;
  const date = createdDate ?? statSync(path).mtime.toISOString().slice(0, 10);
  return join(dirname(path), `${date}-${id}.md`);
}

function rewriteReference(value: unknown, idMap: Map<string, string>): string | null {
  if (typeof value !== "string") return null;
  return idMap.get(value) ?? value.match(/^\d{4}-\d{2}-\d{2}-(mem_[A-Za-z0-9][A-Za-z0-9_-]*)$/)?.[1] ?? value;
}

function rewriteReferenceList(value: unknown, idMap: Map<string, string>): string[] {
  return stringList(value).map((id) => rewriteReference(id, idMap)!).filter((id, index, all) => all.indexOf(id) === index);
}

function writeDocument(path: string, frontmatter: Record<string, unknown>, body: string): void {
  writeFileSync(path, `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body.trim()}\n`, "utf-8");
}

function readMarker(path: string): MemorySchemaMarker | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as MemorySchemaMarker;
    return typeof parsed.version === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function listFiles(dir: string, extension: string): string[] {
  return readdirSync(dir).map((name) => join(dir, name)).filter((path) => statSync(path).isFile() && path.endsWith(extension));
}

function normalizeKind(value: unknown): "preference" | "fact" | "decision" | "lesson" | "state" {
  if (value === "preference" || value === "decision" || value === "lesson" || value === "state") return value;
  if (value === "summary" || value === "episode" || value === "milestone") return "state";
  return "fact";
}

function inferRole(kind: string, tags: string[]): string {
  if (tags.some((tag) => ["identity", "preferred-name", "profile"].includes(tag))) return "identity";
  if (kind === "preference" || kind === "decision" || kind === "lesson" || kind === "state") return kind;
  if (tags.some((tag) => ["constraint", "instruction"].includes(tag))) return "constraint";
  return "fact";
}

function evidenceFromLegacySource(source: unknown): Array<Record<string, unknown>> {
  if (!source || typeof source !== "object" || Array.isArray(source)) return [{ type: "manual" }];
  const record = source as Record<string, unknown>;
  if (typeof record.path === "string") return [{ type: "external_file", path: record.path, runId: record.run_id }];
  if (Array.isArray(record.record_ids)) {
    return record.record_ids.filter((id): id is string => typeof id === "string")
      .map((id) => ({ type: "user_message", id, runId: record.run_id }));
  }
  return [{ type: "manual", runId: record.run_id }];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))) : [];
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
