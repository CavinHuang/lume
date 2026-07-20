import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import YAML from "yaml";
import type { WikiBlockOwner, WikiBlockPatch, WikiPageFrontmatter, WikiPageRecord, WikiPageType, WikiWorkspaceSnapshot } from "@lume/shared";
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
  return createManagedWikiBody({ sourceIds });
}

export function createManagedWikiBody(input: {
  summary?: string;
  known?: string;
  userNotes?: string;
  openQuestions?: string;
  related?: string;
  sourceIds?: string[];
} = {}): string {
  const sourceIds = input.sourceIds ?? [];
  return [
    serializeOwnedBlock("agent", `# 摘要\n\n${input.summary?.trim() ?? ""}\n`, sourceIds),
    serializeOwnedBlock("agent", `# 已知内容\n\n${input.known?.trim() ?? ""}\n`, sourceIds),
    serializeOwnedBlock("user", `# 用户批注\n\n${input.userNotes?.trim() ?? ""}\n`, []),
    serializeOwnedBlock("agent", `# 开放问题\n\n${input.openQuestions?.trim() ?? ""}\n`, sourceIds),
    serializeOwnedBlock("agent", `# 相关页面\n\n${input.related?.trim() ?? ""}\n`, sourceIds),
  ].join("");
}

function serializeOwnedBlock(owner: WikiBlockOwner, content: string, sourceIds: string[], marker?: WikiBlockMarker): string {
  const normalized = content.trimEnd() + "\n";
  const value: WikiBlockMarker = {
    block_id: marker?.block_id ?? randomUUID(),
    owner,
    revision: marker ? marker.revision + 1 : 1,
    source_ids: sourceIds,
    content_hash: sha256(normalized),
  };
  return `<!-- lume:block ${JSON.stringify(value)} -->\n${normalized}`;
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

export interface WikiBlockRegion extends WikiBlockMarker {
  markerStart: number;
  contentStart: number;
  contentEnd: number;
  content: string;
}

export function parseBlockRegions(markdown: string): WikiBlockRegion[] {
  const matches = [...markdown.matchAll(BLOCK_MARKER)];
  return matches.map((match, index) => {
    let raw: WikiBlockMarker;
    try {
      raw = JSON.parse(match[1] ?? "{}") as WikiBlockMarker;
      if (raw.owner !== "agent" && raw.owner !== "user") throw new Error();
      if (!raw.block_id || !Number.isInteger(raw.revision) || raw.revision < 1 || !Array.isArray(raw.source_ids) || !raw.content_hash) throw new Error();
    } catch {
      throw new Error("Wiki block ownership marker 无法解析");
    }
    const markerStart = match.index ?? 0;
    const contentStart = markerStart + match[0].length + (markdown.slice(markerStart + match[0].length).startsWith("\n") ? 1 : 0);
    const contentEnd = matches[index + 1]?.index ?? markdown.length;
    return { ...raw, markerStart, contentStart, contentEnd, content: markdown.slice(contentStart, contentEnd) };
  });
}

export function parseBlockMarkers(markdown: string): WikiBlockMarker[] {
  return parseBlockRegions(markdown).map(({ markerStart: _markerStart, contentStart: _contentStart, contentEnd: _contentEnd, content: _content, ...marker }) => marker);
}

export function applyWikiBlockPatches(body: string, patches: WikiBlockPatch[]): string {
  const regions = parseBlockRegions(body);
  const byId = new Map(regions.map((region) => [region.block_id, region]));
  const replacements = patches.map((patch) => {
    const region = byId.get(patch.blockId);
    if (!region) throw new Error(`WIKI_BLOCK_NOT_FOUND: ${patch.blockId}`);
    if (region.owner !== "agent") throw new Error(`WIKI_USER_BLOCK_PROTECTED: ${patch.blockId}`);
    if (region.content_hash !== patch.expectedContentHash || sha256(region.content) !== patch.expectedContentHash) {
      throw new Error(`WIKI_BLOCK_STALE: ${patch.blockId}`);
    }
    const replacement = patch.action === "delete"
      ? ""
      : serializeOwnedBlock("agent", patch.content ?? "", region.source_ids, region);
    return { start: region.markerStart, end: region.contentEnd, replacement };
  }).sort((left, right) => right.start - left.start);
  let next = body;
  for (const replacement of replacements) {
    next = `${next.slice(0, replacement.start)}${replacement.replacement}${next.slice(replacement.end)}`;
  }
  return next;
}

export function removePurgedSourceBlocks(body: string, sourceIds: string[]): string {
  const selected = new Set(sourceIds);
  const replacements = parseBlockRegions(body).flatMap((region) => {
    if (region.owner !== "agent" || !region.source_ids.some((sourceId) => selected.has(sourceId))) return [];
    const remainingSourceIds = region.source_ids.filter((sourceId) => !selected.has(sourceId));
    return [{
      start: region.markerStart,
      end: region.contentEnd,
      replacement: remainingSourceIds.length === 0
        ? ""
        : serializeOwnedBlock("agent", region.content, remainingSourceIds, region),
    }];
  }).sort((left, right) => right.start - left.start);
  let next = body;
  for (const replacement of replacements) {
    next = `${next.slice(0, replacement.start)}${replacement.replacement}${next.slice(replacement.end)}`;
  }
  return next;
}

export function promoteExternallyEditedBlocks(body: string): { body: string; changed: boolean; ambiguous: boolean } {
  try {
    const regions = parseBlockRegions(body);
    if (regions.length === 0) return { body, changed: false, ambiguous: true };
    const replacements = regions.flatMap((region) => {
      if (sha256(region.content) === region.content_hash) return [];
      return [{
        start: region.markerStart,
        end: region.contentEnd,
        replacement: serializeOwnedBlock("user", region.content, region.source_ids, { ...region, owner: "user" }),
      }];
    }).sort((left, right) => right.start - left.start);
    let next = body;
    for (const replacement of replacements) next = `${next.slice(0, replacement.start)}${replacement.replacement}${next.slice(replacement.end)}`;
    return { body: next, changed: replacements.length > 0, ambiguous: false };
  } catch {
    return { body, changed: false, ambiguous: true };
  }
}

export function hasUnsafeWikiOwnership(body: string): boolean {
  try {
    const regions = parseBlockRegions(body);
    return regions.length === 0 || regions.some((region) => region.owner === "agent" && sha256(region.content) !== region.content_hash);
  } catch {
    return true;
  }
}

export function promoteEditedWikiBlocksToUser(previousBody: string, editedBody: string): { body: string; ambiguous: boolean } {
  try {
    const previous = parseBlockRegions(previousBody);
    const edited = parseBlockRegions(editedBody);
    const previousById = new Map(previous.map((region) => [region.block_id, region]));
    if (previous.length === 0 || edited.length !== previous.length || edited.some((region) => !previousById.has(region.block_id))) {
      return { body: editedBody, ambiguous: true };
    }
    const replacements = edited.flatMap((region) => {
      const before = previousById.get(region.block_id)!;
      if (before.content === region.content && before.owner === region.owner && before.content_hash === region.content_hash) return [];
      return [{
        start: region.markerStart,
        end: region.contentEnd,
        replacement: serializeOwnedBlock("user", region.content, region.source_ids, { ...region, owner: "user" }),
      }];
    }).sort((left, right) => right.start - left.start);
    let body = editedBody;
    for (const replacement of replacements) {
      body = `${body.slice(0, replacement.start)}${replacement.replacement}${body.slice(replacement.end)}`;
    }
    return { body, ambiguous: false };
  } catch {
    return { body: editedBody, ambiguous: true };
  }
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

  listPages(protectUnsafe = true): WikiPageRecord[] {
    this.ensureLayout();
    const records: WikiPageRecord[] = [];
    for (const base of ["inbox", "workspaces", "archived-workspaces"]) this.scan(base, records);
    const protectedIds = this.protectedPageIds();
    for (const record of records) {
      if (protectUnsafe && hasUnsafeWikiOwnership(record.body) && !protectedIds.has(record.id)) {
        this.markProtected(record.id, "检测到非 coordinator ownership 变化或缺失 marker");
        protectedIds.add(record.id);
      }
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
