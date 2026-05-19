import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { getMemoryV2ScopePaths, type MemoryV2ScopePaths } from "./paths";
import type {
  MemoryV2Candidate,
  MemoryV2Entry,
  MemoryV2EntryFrontmatter,
  MemoryV2PendingFrontmatter,
  MemoryV2PendingItem,
  MemoryV2PendingType,
  MemoryV2Scope,
  MemoryV2Source,
  MemoryV2Status
} from "./types";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface MemoryV2Store {
  ensureMemoryFile(scope: MemoryV2Scope, workspaceSlug?: string): string;
  writeEntry(candidate: MemoryV2Candidate, input?: {
    status?: MemoryV2Status;
    pinned?: boolean;
    related?: string[];
    supersedes?: string[];
    source?: MemoryV2Source;
  }): MemoryV2Entry;
  updateEntryStatus(input: {
    scope: MemoryV2Scope;
    workspaceSlug?: string;
    id: string;
    status: MemoryV2Status;
    supersededBy?: string | null;
  }): MemoryV2Entry;
  writePending(input: {
    type: MemoryV2PendingType;
    candidate: MemoryV2Candidate;
    existingIds?: string[];
    reason: string;
  }): MemoryV2PendingItem;
  listEntries(input: {
    workspaceSlug?: string;
    scopes?: MemoryV2Scope[];
    includeStatuses?: MemoryV2Status[];
  }): MemoryV2Entry[];
  readMemoryMarkdown(scope: MemoryV2Scope, workspaceSlug?: string): string;
  appendDaily(input: {
    scope: MemoryV2Scope;
    workspaceSlug?: string;
    date?: Date;
    heading: string;
    body: string;
  }): string;
  appendRunArchive(input: {
    workspaceSlug: string;
    runId: string;
    record: Record<string, unknown>;
  }): string;
}

export function createMemoryV2Store(): MemoryV2Store {
  return {
    ensureMemoryFile,
    writeEntry,
    updateEntryStatus,
    writePending,
    listEntries,
    readMemoryMarkdown,
    appendDaily,
    appendRunArchive
  };
}

export function ensureMemoryFile(scope: MemoryV2Scope, workspaceSlug?: string): string {
  const paths = getMemoryV2ScopePaths({ scope, workspaceSlug });
  if (!existsSync(paths.memoryMd)) {
    const title = scope === "global" ? "Global Memory" : "Workspace Memory";
    writeFileAtomic(paths.memoryMd, `# ${title}\n\n`);
  }
  return paths.memoryMd;
}

export function writeEntry(candidate: MemoryV2Candidate, input: {
  status?: MemoryV2Status;
  pinned?: boolean;
  related?: string[];
  supersedes?: string[];
  source?: MemoryV2Source;
} = {}): MemoryV2Entry {
  const paths = getMemoryV2ScopePaths({
    scope: candidate.targetScope,
    workspaceSlug: candidate.targetScope === "workspace" ? candidateWorkspace(candidate) : undefined
  });
  const now = new Date().toISOString();
  const id = createMemoryId(now);
  const source = input.source ?? memorySourceFromCandidate(candidate);
  const frontmatter: MemoryV2EntryFrontmatter = {
    id,
    kind: candidate.kind,
    scope: candidate.targetScope,
    status: input.status ?? "active",
    created: now,
    updated: now,
    source,
    confidence: candidate.confidence,
    pinned: input.pinned ?? false,
    tags: cleanList(candidate.tags),
    entities: cleanList(candidate.entities),
    related: cleanList(input.related),
    supersedes: cleanList(input.supersedes),
    superseded_by: null,
    applies_when: candidate.appliesWhen ?? {},
    valid_from: null,
    valid_to: null
  };
  const filename = `${now.slice(0, 10)}-${id}.md`;
  const path = join(paths.entriesDir, filename);
  const entry = { frontmatter, statement: candidate.statement.trim(), path };
  writeMarkdownDocument(path, frontmatter, entry.statement);
  return entry;
}

export function updateEntryStatus(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
  id: string;
  status: MemoryV2Status;
  supersededBy?: string | null;
}): MemoryV2Entry {
  const entry = findEntryById(input);
  if (!entry) {
    throw new Error(`Memory entry not found: ${input.id}`);
  }
  const next: MemoryV2Entry = {
    ...entry,
    frontmatter: {
      ...entry.frontmatter,
      status: input.status,
      superseded_by: input.supersededBy === undefined
        ? entry.frontmatter.superseded_by
        : input.supersededBy,
      updated: new Date().toISOString()
    }
  };
  writeMarkdownDocument(next.path, next.frontmatter, next.statement);
  return next;
}

export function writePending(input: {
  type: MemoryV2PendingType;
  candidate: MemoryV2Candidate;
  existingIds?: string[];
  reason: string;
}): MemoryV2PendingItem {
  const scope = input.candidate.targetScope;
  const paths = getMemoryV2ScopePaths({
    scope,
    workspaceSlug: scope === "workspace" ? candidateWorkspace(input.candidate) : undefined
  });
  const now = new Date().toISOString();
  const id = `pending_${compactTimestamp(now)}_${randomUUID().slice(0, 8)}`;
  const frontmatter: MemoryV2PendingFrontmatter = {
    id,
    type: input.type,
    created: now,
    candidate: {
      kind: input.candidate.kind,
      targetScope: input.candidate.targetScope,
      statement: input.candidate.statement.trim()
    },
    existing: input.existingIds?.length ? { ids: input.existingIds } : undefined,
    reason: input.reason,
    evidence: input.candidate.evidence
      ? {
          run_id: input.candidate.evidence.runId,
          record_ids: input.candidate.evidence.recordIds
        }
      : undefined,
    status: "open"
  };
  const pendingDir = pendingTypeDir(paths, input.type);
  const path = join(pendingDir, `${now.slice(0, 10)}-${id}.md`);
  const body = input.reason.trim();
  writeMarkdownDocument(path, frontmatter, body);
  return { frontmatter, body, path };
}

export function listEntries(input: {
  workspaceSlug?: string;
  scopes?: MemoryV2Scope[];
  includeStatuses?: MemoryV2Status[];
} = {}): MemoryV2Entry[] {
  const scopes = input.scopes ?? ["global", "workspace"];
  const entries: MemoryV2Entry[] = [];
  for (const scope of scopes) {
    if (scope === "workspace" && !input.workspaceSlug) continue;
    const paths = getMemoryV2ScopePaths({ scope, workspaceSlug: input.workspaceSlug });
    for (const path of listMarkdownFiles(paths.entriesDir)) {
      try {
        const entry = readEntryFile(path);
        if (input.includeStatuses && !input.includeStatuses.includes(entry.frontmatter.status)) continue;
        entries.push(entry);
      } catch {
        continue;
      }
    }
  }
  return entries.sort((a, b) => b.frontmatter.updated.localeCompare(a.frontmatter.updated));
}

export function readMemoryMarkdown(scope: MemoryV2Scope, workspaceSlug?: string): string {
  const path = ensureMemoryFile(scope, workspaceSlug);
  return readFileSync(path, "utf-8");
}

export function appendDaily(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
  date?: Date;
  heading: string;
  body: string;
}): string {
  const date = input.date ?? new Date();
  const paths = getMemoryV2ScopePaths({ scope: input.scope, workspaceSlug: input.workspaceSlug });
  const path = join(paths.dailyDir, `${date.toISOString().slice(0, 10)}.md`);
  const existing = existsSync(path) ? readFileSync(path, "utf-8").trimEnd() : `# ${date.toISOString().slice(0, 10)}\n`;
  const section = [
    existing,
    "",
    `## ${input.heading.trim()}`,
    "",
    input.body.trim(),
    ""
  ].join("\n");
  writeFileAtomic(path, section);
  return path;
}

export function appendRunArchive(input: {
  workspaceSlug: string;
  runId: string;
  record: Record<string, unknown>;
}): string {
  const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: input.workspaceSlug });
  if (!paths.runsDir) {
    throw new Error("workspace runs directory missing");
  }
  const path = join(paths.runsDir, `run_${safeSegment(input.runId)}.jsonl`);
  const record = redactArchiveRecord({
    id: `${input.runId}:evt_${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...input.record
  });
  mkdirSync(paths.runsDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8", flag: "a" });
  return path;
}

export function readEntryFile(path: string): MemoryV2Entry {
  const { frontmatter, body } = parseMarkdownDocument<MemoryV2EntryFrontmatter>(readFileSync(path, "utf-8"));
  return {
    frontmatter: normalizeEntryFrontmatter(frontmatter, path),
    statement: body.trim(),
    path
  };
}

export function parseMarkdownDocument<T extends object>(source: string): {
  frontmatter: T;
  body: string;
} {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error("Markdown document is missing YAML frontmatter");
  }
  const parsed = YAML.parse(match[1] ?? "") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Markdown frontmatter must be an object");
  }
  return {
    frontmatter: parsed as T,
    body: source.slice(match[0].length)
  };
}

export function writeMarkdownDocument(path: string, frontmatter: unknown, body: string): void {
  const yaml = YAML.stringify(frontmatter).trimEnd();
  writeFileAtomic(path, `---\n${yaml}\n---\n${body.trim()}\n`);
}

export function redactArchiveRecord(record: Record<string, unknown>): Record<string, unknown> & { redacted: boolean } {
  let redacted = false;
  const redactValue = (key: string, value: unknown): unknown => {
    if (isSecretKey(key) && value !== undefined && value !== null) {
      redacted = true;
      return "[REDACTED]";
    }
    if (typeof value === "string") {
      const next = value
        .replace(/(sk-[A-Za-z0-9_-]{16,})/g, () => {
          redacted = true;
          return "[REDACTED]";
        })
        .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, (_match, prefix: string) => {
          redacted = true;
          return `${prefix}[REDACTED]`;
        });
      return next;
    }
    if (Array.isArray(value)) return value.map((item) => redactValue(key, item));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        out[childKey] = redactValue(childKey, childValue);
      }
      return out;
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = redactValue(key, value);
  }
  return { ...out, redacted };
}

function findEntryById(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
  id: string;
}): MemoryV2Entry | undefined {
  return listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: [input.scope]
  }).find((entry) => entry.frontmatter.id === input.id);
}

function normalizeEntryFrontmatter(raw: MemoryV2EntryFrontmatter, path: string): MemoryV2EntryFrontmatter {
  if (!raw.id || !raw.kind || !raw.scope) {
    throw new Error(`Invalid memory entry frontmatter: ${path}`);
  }
  return {
    ...raw,
    tags: cleanList(raw.tags),
    entities: cleanList(raw.entities),
    related: cleanList(raw.related),
    supersedes: cleanList(raw.supersedes),
    superseded_by: raw.superseded_by ?? null,
    applies_when: raw.applies_when ?? {},
    valid_from: raw.valid_from ?? null,
    valid_to: raw.valid_to ?? null,
    pinned: Boolean(raw.pinned)
  };
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((path) => {
      try {
        return statSync(path).isFile() && path.endsWith(".md");
      } catch {
        return false;
      }
    });
}

function pendingTypeDir(paths: MemoryV2ScopePaths, type: MemoryV2PendingType): string {
  if (type === "conflict") return paths.pendingConflictsDir;
  if (type === "stale") return paths.pendingStaleDir;
  return paths.pendingLowConfidenceDir;
}

function memorySourceFromCandidate(candidate: MemoryV2Candidate): MemoryV2Source {
  return {
    type: "manual",
    run_id: candidate.evidence?.runId,
    record_ids: candidate.evidence?.recordIds,
    path: candidate.evidence?.sourcePaths?.[0]
  };
}

function candidateWorkspace(candidate: MemoryV2Candidate): string | undefined {
  return candidate.appliesWhen?.workspaceSlug;
}

function createMemoryId(now: string): string {
  return `mem_${compactTimestamp(now)}_${randomUUID().slice(0, 8)}`;
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function cleanList(values?: unknown): string[] {
  return Array.isArray(values)
    ? Array.from(new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)))
    : [];
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const hash = createHash("sha1").update(`${path}:${content}:${Date.now()}`).digest("hex").slice(0, 8);
  const tempPath = `${path}.tmp.${hash}`;
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, path);
}

function safeSegment(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isSecretKey(key: string): boolean {
  return /api[_-]?key|token|secret|authorization|password|private[_-]?key/i.test(key);
}
