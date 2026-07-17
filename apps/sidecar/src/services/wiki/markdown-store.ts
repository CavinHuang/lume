import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import YAML from "yaml";
import type { WikiBlockOwner, WikiPageFrontmatter, WikiPageRecord, WikiPageType, WikiWorkspaceSnapshot } from "@lume/shared";
import { WIKI_SCHEMA_VERSION } from "@lume/shared";
import { assertWikiSegment, assertWikiUuid, ensureWikiDirectory, resolveWikiPath } from "./path-security";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const BLOCK_MARKER = /<!--\s*lume:block\s+({[^\n]+})\s*-->/g;

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createWikiFileKey(): string {
  return `wiki-${randomUUID()}`;
}

export function workspaceDirectoryName(workspace: WikiWorkspaceSnapshot): string {
  const id = assertWikiUuid(workspace.id);
  const slug = workspace.slug.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  return `${id}--${slug.slice(0, 80)}`;
}

export function wikiPageRelativePath(frontmatter: WikiPageFrontmatter): string {
  const fileKey = assertWikiSegment(frontmatter.file_key, "file_key");
  if (frontmatter.primary_workspace_id === null) return join("inbox", `${fileKey}.md`);
  if (!frontmatter.primary_workspace_snapshot || frontmatter.primary_workspace_snapshot.id !== frontmatter.primary_workspace_id) {
    throw new Error("primary workspace snapshot 与 UUID 不一致");
  }
  const base = frontmatter.status === "archived" ? "archived-workspaces" : "workspaces";
  const typeDirectory: Record<WikiPageType, string> = {
    source: "sources",
    topic: "topics",
    decision: "decisions",
    synthesis: "synthesis"
  };
  return join(base, workspaceDirectoryName(frontmatter.primary_workspace_snapshot), typeDirectory[frontmatter.type], `${fileKey}.md`);
}

export function createWikiPageMarkdown(input: {
  id?: string;
  fileKey?: string;
  type: WikiPageType;
  title: string;
  primaryWorkspace: WikiWorkspaceSnapshot | null;
  associatedWorkspaceIds?: string[];
  aliases?: string[];
  tags?: string[];
  sourceIds?: string[];
  body?: string;
  now?: string;
}): string {
  const now = input.now ?? new Date().toISOString();
  const fm: WikiPageFrontmatter = {
    schema_version: WIKI_SCHEMA_VERSION,
    id: input.id ?? randomUUID(),
    file_key: input.fileKey ?? createWikiFileKey(),
    type: input.type,
    title: input.title.trim() || "未命名页面",
    primary_workspace_id: input.primaryWorkspace?.id ?? null,
    primary_workspace_snapshot: input.primaryWorkspace,
    associated_workspace_ids: uniqueUuids(input.associatedWorkspaceIds ?? []),
    status: "active",
    aliases: uniqueStrings(input.aliases ?? []),
    tags: uniqueStrings(input.tags ?? []),
    source_ids: uniqueStrings(input.sourceIds ?? []),
    created: now,
    updated: now,
    revision: 1
  };
  return serializeWikiPage(fm, input.body ?? defaultBody(input.sourceIds ?? []));
}

function defaultBody(sourceIds: string[]): string {
  const marker = JSON.stringify({ block_id: randomUUID(), owner: "agent", revision: 1, source_ids: sourceIds, content_hash: sha256("") });
  return `# 摘要\n\n<!-- lume:block ${marker} -->\n\n# 已知内容\n\n# 用户批注\n\n# 开放问题\n\n# 相关页面\n`;
}

export function serializeWikiPage(frontmatter: WikiPageFrontmatter, body: string): string {
  validateFrontmatter(frontmatter);
  return `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trimEnd()}\n`;
}

export function parseWikiPage(markdown: string, path = ""): WikiPageRecord {
  const match = markdown.match(FRONTMATTER);
  if (!match) throw new Error("Wiki 页面缺少 YAML frontmatter");
  const raw = YAML.parse(match[1] ?? "") as WikiPageFrontmatter;
  const frontmatter = normalizeFrontmatter(raw);
  const body = markdown.slice(match[0].length);
  return {
    id: frontmatter.id,
    fileKey: frontmatter.file_key,
    title: frontmatter.title,
    type: frontmatter.type,
    status: frontmatter.status,
    primaryWorkspaceId: frontmatter.primary_workspace_id,
    associatedWorkspaceIds: frontmatter.associated_workspace_ids,
    path,
    frontmatter,
    markdown,
    body,
    hash: sha256(markdown),
    revision: frontmatter.revision,
    protected: frontmatter.protected === true
  };
}

function normalizeFrontmatter(raw: WikiPageFrontmatter): WikiPageFrontmatter {
  const fm: WikiPageFrontmatter = {
    ...raw,
    associated_workspace_ids: uniqueUuids(raw.associated_workspace_ids ?? []),
    aliases: uniqueStrings(raw.aliases ?? []),
    tags: uniqueStrings(raw.tags ?? []),
    source_ids: uniqueStrings(raw.source_ids ?? [])
  };
  validateFrontmatter(fm);
  return fm;
}

export function validateFrontmatter(fm: WikiPageFrontmatter): void {
  if (fm.schema_version !== WIKI_SCHEMA_VERSION) throw new Error("不支持的 Wiki schema_version");
  assertWikiUuid(fm.id, "page id");
  assertWikiSegment(fm.file_key, "file_key");
  if (!["source", "topic", "decision", "synthesis"].includes(fm.type)) throw new Error("Wiki page type 非法");
  if (!["active", "archived", "trashed"].includes(fm.status)) throw new Error("Wiki page status 非法");
  if (!fm.title?.trim()) throw new Error("Wiki title 不能为空");
  if (!Number.isInteger(fm.revision) || fm.revision < 1) throw new Error("Wiki revision 非法");
  if (fm.primary_workspace_id !== null) assertWikiUuid(fm.primary_workspace_id);
  fm.associated_workspace_ids.forEach((id) => assertWikiUuid(id, "associated workspace id"));
}

export interface WikiBlockMarker {
  block_id: string;
  owner: WikiBlockOwner;
  revision: number;
  source_ids: string[];
  content_hash: string;
}

export function parseBlockMarkers(markdown: string): WikiBlockMarker[] {
  const markers: WikiBlockMarker[] = [];
  for (const match of markdown.matchAll(BLOCK_MARKER)) {
    try {
      const raw = JSON.parse(match[1] ?? "{}") as WikiBlockMarker;
      if (raw.owner !== "agent" && raw.owner !== "user") throw new Error();
      markers.push(raw);
    } catch {
      throw new Error("Wiki block ownership marker 无法解析");
    }
  }
  return markers;
}

export function extractWikiLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((match) => match[1]!.trim()).filter(Boolean);
}

export class WikiMarkdownStore {
  constructor(readonly root: string) {}

  ensureLayout(): void {
    for (const path of ["inbox", "workspaces", "archived-workspaces", "assets", ".lume/index", ".lume/operations", ".lume/snapshots", ".lume/pending", ".lume/staging", ".lume/trash", ".lume/sources/blobs", ".lume/sources/records"]) {
      ensureWikiDirectory(this.root, path);
    }
  }

  listPages(): WikiPageRecord[] {
    this.ensureLayout();
    const records: WikiPageRecord[] = [];
    for (const base of ["inbox", "workspaces", "archived-workspaces"]) this.scan(base, records);
    const protectedIds = this.protectedPageIds();
    for (const record of records) {
      if (!protectedIds.has(record.id)) continue;
      record.protected = true;
      record.frontmatter = { ...record.frontmatter, protected: true };
    }
    return records;
  }

  markProtected(pageId: string, reason: string): void {
    assertWikiUuid(pageId, "page id");
    appendFileSync(
      resolveWikiPath(this.root, ".lume/protected-pages.jsonl"),
      `${JSON.stringify({ pageId, reason, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  }

  private scan(relativeDir: string, out: WikiPageRecord[]): void {
    const directory = resolveWikiPath(this.root, relativeDir);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = join(relativeDir, entry.name);
      const path = resolveWikiPath(this.root, relativePath);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Wiki scan 拒绝 symlink: ${relativePath}`);
      if (stat.isDirectory()) this.scan(relativePath, out);
      else if (entry.name.endsWith(".md")) out.push(parseWikiPage(readFileSync(path, "utf8"), relativePath));
    }
  }

  readById(id: string): WikiPageRecord | undefined {
    return this.listPages().find((page) => page.id === id);
  }

  readRelative(relativePath: string): WikiPageRecord {
    const path = resolveWikiPath(this.root, relativePath);
    return parseWikiPage(readFileSync(path, "utf8"), relativePath);
  }

  hashRelative(relativePath: string): string | null {
    const path = resolveWikiPath(this.root, relativePath);
    return existsSync(path) ? sha256(readFileSync(path)) : null;
  }

  atomicReplace(relativePath: string, markdown: string): void {
    const target = resolveWikiPath(this.root, relativePath);
    ensureWikiDirectory(this.root, relative(this.root, dirname(target)));
    const tempRelative = `${relativePath}.${randomUUID()}.tmp`;
    const temp = resolveWikiPath(this.root, tempRelative);
    writeFileSync(temp, markdown, { encoding: "utf8", flag: "wx" });
    resolveWikiPath(this.root, relativePath);
    renameSync(temp, target);
  }

  remove(relativePath: string): void {
    const target = resolveWikiPath(this.root, relativePath);
    if (!existsSync(target)) return;
    const trashRelative = join(".lume", "trash", `${basename(relativePath)}.${randomUUID()}`);
    const trash = resolveWikiPath(this.root, trashRelative);
    renameSync(target, trash);
  }

  private protectedPageIds(): Set<string> {
    const path = resolveWikiPath(this.root, ".lume/protected-pages.jsonl");
    if (!existsSync(path)) return new Set();
    return new Set(readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => (JSON.parse(line) as { pageId: string }).pageId));
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function uniqueUuids(values: string[]): string[] {
  return uniqueStrings(values).map((id) => assertWikiUuid(id));
}
