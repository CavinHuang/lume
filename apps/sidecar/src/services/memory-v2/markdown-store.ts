import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { getMemoryV2ScopePaths, type MemoryV2ScopePaths } from "./paths";
import { inferMemoryV2Claim, normalizeMemoryV2Claim } from "./claim";
import type {
  MemoryV2Activation,
  MemoryV2Candidate,
  MemoryV2Entry,
  MemoryV2EntryFrontmatter,
  MemoryV2EvidenceRef,
  MemoryV2Kind,
  MemoryV2PendingFrontmatter,
  MemoryV2PendingItem,
  MemoryV2PendingType,
  MemoryV2Scope,
  MemoryV2SemanticRole,
  MemoryV2Source,
  MemoryV2Status
} from "./types";
import { DEFAULT_ACTIVATION } from "./types";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const ALL_ENTRY_STATUSES: MemoryV2Status[] = [
  "active",
  "archived",
  "superseded",
  "pending_conflict",
  "pending_low_confidence",
  "suspected_stale"
];

export interface MemoryV2Store {
  ensureMemoryFile(scope: MemoryV2Scope, workspaceSlug?: string): string;
  writeEntry(candidate: MemoryV2Candidate, input?: {
    status?: MemoryV2Status;
    pinned?: boolean;
    related?: string[];
    supersedes?: string[];
    source?: MemoryV2Source;
    activation?: MemoryV2Activation;
    evidenceRefs?: MemoryV2EvidenceRef[];
  }): MemoryV2Entry;
  updateEntryStatus(input: {
    scope: MemoryV2Scope;
    workspaceSlug?: string;
    id: string;
    status: MemoryV2Status;
    supersededBy?: string | null;
    evidenceRefs?: MemoryV2EvidenceRef[];
    expectedRevision?: number;
  }): MemoryV2Entry;
  updateEntryRelations(input: {
    scope: MemoryV2Scope;
    workspaceSlug?: string;
    id: string;
    related: string[];
  }): MemoryV2Entry;
  updateEntry(input: {
    scope: MemoryV2Scope;
    workspaceSlug?: string;
    id: string;
    statement?: string;
    kind?: MemoryV2EntryFrontmatter["kind"];
    confidence?: MemoryV2EntryFrontmatter["confidence"];
    tags?: string[];
    activation?: MemoryV2Activation;
    facets?: string[];
    pinned?: boolean;
    validTo?: string | null;
    evidenceRefs?: MemoryV2EvidenceRef[];
    lastConfirmedAt?: string;
    expectedRevision?: number;
  }): MemoryV2Entry;
  moveEntryScope(input: {
    scope: MemoryV2Scope;
    targetScope: MemoryV2Scope;
    workspaceSlug: string;
    id: string;
    expectedRevision?: number;
  }): MemoryV2Entry;
  deleteEntry(input: {
    scope: MemoryV2Scope;
    workspaceSlug?: string;
    id: string;
  }): { ok: true; id: string; path: string };
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
  listPending(input: {
    workspaceSlug?: string;
    scopes?: MemoryV2Scope[];
    includeStatuses?: MemoryV2PendingFrontmatter["status"][];
  }): MemoryV2PendingItem[];
  resolvePending(input: {
    workspaceSlug: string;
    path: string;
    action: "accept" | "reject" | "resolve";
    candidateOverride?: {
      statement?: string;
      kind?: MemoryV2EntryFrontmatter["kind"];
      confidence?: MemoryV2EntryFrontmatter["confidence"];
      tags?: string[];
    };
  }): { ok: true; id: string; path: string; entryId?: string; entryPath?: string };
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
    updateEntryRelations,
    updateEntry,
    moveEntryScope,
    deleteEntry,
    writePending,
    listEntries,
    listPending,
    resolvePending,
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
  activation?: MemoryV2Activation;
  evidenceRefs?: MemoryV2EvidenceRef[];
} = {}): MemoryV2Entry {
  const paths = getMemoryV2ScopePaths({
    scope: candidate.targetScope,
    workspaceSlug: candidate.targetScope === "workspace" ? candidateWorkspace(candidate) : undefined
  });
  const now = new Date().toISOString();
  const id = createMemoryId(now);
  const source = input.source ?? memorySourceFromCandidate(candidate);
  const kind = candidate.kind ?? kindFromSemanticRole(candidate.semanticRole);
  const semanticRole = candidate.semanticRole ?? semanticRoleFromKind(kind, candidate.tags);
  const frontmatter: MemoryV2EntryFrontmatter = {
    id,
    kind,
    semantic_role: semanticRole,
    facets: cleanList(candidate.facets ?? candidate.tags),
    scope: candidate.targetScope,
    status: input.status ?? "active",
    created: now,
    updated: now,
    last_confirmed_at: now,
    revision: 1,
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
    valid_to: null,
    activation: input.activation ? { ...input.activation } : { ...DEFAULT_ACTIVATION },
    evidence_refs: input.evidenceRefs ?? evidenceRefsFromCandidate(candidate),
    ...(candidate.claim ? { claim: candidate.claim } : {})
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
  evidenceRefs?: MemoryV2EvidenceRef[];
  expectedRevision?: number;
}): MemoryV2Entry {
  const entry = findEntryById(input);
  if (!entry) {
    throw new Error(`Memory entry not found: ${input.id}`);
  }
  assertRevision(entry, input.expectedRevision);
  const next: MemoryV2Entry = {
    ...entry,
    frontmatter: {
      ...entry.frontmatter,
      status: input.status,
      superseded_by: input.supersededBy === undefined
        ? entry.frontmatter.superseded_by
        : input.supersededBy,
      evidence_refs: input.evidenceRefs
        ? uniqueEvidenceRefs([...entry.frontmatter.evidence_refs, ...input.evidenceRefs])
        : entry.frontmatter.evidence_refs,
      updated: new Date().toISOString(),
      revision: entry.frontmatter.revision + 1
    }
  };
  writeMarkdownDocument(next.path, next.frontmatter, next.statement);
  return next;
}

export function updateEntryRelations(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
  id: string;
  related: string[];
}): MemoryV2Entry {
  const entry = findEntryById(input);
  if (!entry) {
    throw new Error(`Memory entry not found: ${input.id}`);
  }
  const nextRelated = cleanList([...entry.frontmatter.related, ...input.related]);
  const next: MemoryV2Entry = {
    ...entry,
    frontmatter: {
      ...entry.frontmatter,
      related: nextRelated,
      updated: new Date().toISOString(),
      revision: entry.frontmatter.revision + 1
    }
  };
  writeMarkdownDocument(next.path, next.frontmatter, next.statement);
  return next;
}

export function updateEntry(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
  id: string;
  statement?: string;
  kind?: MemoryV2EntryFrontmatter["kind"];
  confidence?: MemoryV2EntryFrontmatter["confidence"];
  tags?: string[];
  activation?: MemoryV2Activation;
  facets?: string[];
  pinned?: boolean;
  validTo?: string | null;
  evidenceRefs?: MemoryV2EvidenceRef[];
  lastConfirmedAt?: string;
  expectedRevision?: number;
}): MemoryV2Entry {
  const entry = findEntryById(input);
  if (!entry) {
    throw new Error(`Memory entry not found: ${input.id}`);
  }
  assertRevision(entry, input.expectedRevision);
  const nextStatement = input.statement === undefined ? entry.statement : input.statement.trim();
  if (!nextStatement) {
    throw new Error("Memory entry statement cannot be empty");
  }
  const nextTags = input.tags ? cleanList(input.tags) : entry.frontmatter.tags;
  const nextClaim = inferMemoryV2Claim({
    statement: nextStatement,
    tags: nextTags
  }) ?? entry.frontmatter.claim;
  const previousActivation = readActivation(entry.frontmatter);
  const nextActivation = input.activation ? { ...input.activation } : previousActivation;
  const next: MemoryV2Entry = {
    ...entry,
    statement: nextStatement,
    frontmatter: {
      ...entry.frontmatter,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.confidence ? { confidence: input.confidence } : {}),
      tags: nextTags,
      facets: input.facets ? cleanList(input.facets) : entry.frontmatter.facets,
      pinned: input.pinned ?? entry.frontmatter.pinned,
      valid_to: input.validTo === undefined ? entry.frontmatter.valid_to : input.validTo,
      activation: nextActivation,
      evidence_refs: input.evidenceRefs
        ? uniqueEvidenceRefs([...entry.frontmatter.evidence_refs, ...input.evidenceRefs])
        : entry.frontmatter.evidence_refs,
      ...(nextClaim ? { claim: nextClaim } : {}),
      updated: new Date().toISOString(),
      last_confirmed_at: input.lastConfirmedAt ?? new Date().toISOString(),
      revision: entry.frontmatter.revision + 1
    }
  };
  writeMarkdownDocument(next.path, next.frontmatter, next.statement);
  return next;
}

function uniqueEvidenceRefs(refs: MemoryV2EvidenceRef[]): MemoryV2EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = JSON.stringify([ref.type, ref.id, ref.runId, ref.threadId, ref.path, ref.quote]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function moveEntryScope(input: {
  scope: MemoryV2Scope;
  targetScope: MemoryV2Scope;
  workspaceSlug: string;
  id: string;
  expectedRevision?: number;
}): MemoryV2Entry {
  const entry = findEntryById({
    scope: input.scope,
    workspaceSlug: input.workspaceSlug,
    id: input.id
  });
  if (!entry) throw new Error(`Memory entry not found: ${input.id}`);
  assertRevision(entry, input.expectedRevision);
  if (input.scope === input.targetScope) return entry;
  const targetPaths = getMemoryV2ScopePaths({
    scope: input.targetScope,
    workspaceSlug: input.targetScope === "workspace" ? input.workspaceSlug : undefined
  });
  const targetPath = join(targetPaths.entriesDir, basename(entry.path));
  if (existsSync(targetPath)) throw new Error(`Memory entry already exists in target scope: ${input.id}`);
  const next: MemoryV2Entry = {
    ...entry,
    path: targetPath,
    frontmatter: {
      ...entry.frontmatter,
      scope: input.targetScope,
      applies_when: input.targetScope === "workspace" ? { workspaceSlug: input.workspaceSlug } : {},
      updated: new Date().toISOString(),
      revision: entry.frontmatter.revision + 1
    }
  };
  writeMarkdownDocument(targetPath, next.frontmatter, next.statement);
  rmSync(entry.path, { force: true });
  return next;
}

export function deleteEntry(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
  id: string;
}): { ok: true; id: string; path: string } {
  const entry = findEntryById(input);
  if (!entry) {
    throw new Error(`Memory entry not found: ${input.id}`);
  }
  rmSync(entry.path, { force: true });
  removeEntryReferences(input.id, input.workspaceSlug);
  return {
    ok: true,
    id: entry.frontmatter.id,
    path: entry.path
  };
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
      kind: input.candidate.kind ?? kindFromSemanticRole(input.candidate.semanticRole),
      semantic_role: input.candidate.semanticRole,
      targetScope: input.candidate.targetScope,
      statement: input.candidate.statement.trim(),
      confidence: input.candidate.confidence,
      tags: cleanList(input.candidate.tags),
      facets: cleanList(input.candidate.facets),
      entities: cleanList(input.candidate.entities),
      appliesWhen: input.candidate.appliesWhen,
      ...(input.candidate.claim ? { claim: input.candidate.claim } : {})
    },
    existing: input.existingIds?.length ? { ids: input.existingIds } : undefined,
    reason: input.reason,
    evidence: input.candidate.evidence
      ? {
          run_id: input.candidate.evidence.runId,
          record_ids: input.candidate.evidence.recordIds
        }
      : undefined,
    evidence_refs: input.candidate.evidenceRefs,
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

export function listPending(input: {
  workspaceSlug?: string;
  scopes?: MemoryV2Scope[];
  includeStatuses?: MemoryV2PendingFrontmatter["status"][];
} = {}): MemoryV2PendingItem[] {
  const scopes = input.scopes ?? ["global", "workspace"];
  const items: MemoryV2PendingItem[] = [];
  for (const scope of scopes) {
    if (scope === "workspace" && !input.workspaceSlug) continue;
    const paths = getMemoryV2ScopePaths({ scope, workspaceSlug: input.workspaceSlug });
    for (const dir of [paths.pendingConflictsDir, paths.pendingStaleDir, paths.pendingLowConfidenceDir]) {
      for (const path of listMarkdownFiles(dir)) {
        try {
          const item = readPendingFile(path);
          if (input.includeStatuses && !input.includeStatuses.includes(item.frontmatter.status)) continue;
          items.push(item);
        } catch {
          continue;
        }
      }
    }
  }
  return items.sort((a, b) => b.frontmatter.created.localeCompare(a.frontmatter.created));
}

export function resolvePending(input: {
  workspaceSlug: string;
  path: string;
  action: "accept" | "reject" | "resolve";
  candidateOverride?: {
    statement?: string;
    kind?: MemoryV2EntryFrontmatter["kind"];
    confidence?: MemoryV2EntryFrontmatter["confidence"];
    tags?: string[];
  };
}): { ok: true; id: string; path: string; entryId?: string; entryPath?: string } {
  const pending = findPendingByPath(input);
  if (!pending) {
    throw new Error("Memory pending item not found");
  }
  if (pending.frontmatter.status !== "open") {
    return {
      ok: true,
      id: pending.frontmatter.id,
      path: pending.path
    };
  }
  if (input.action !== "accept") {
    updatePendingStatus(pending, input.action === "reject" ? "archived" : "resolved");
    return {
      ok: true,
      id: pending.frontmatter.id,
      path: pending.path
    };
  }

  const candidate = candidateFromPending(pending, input.workspaceSlug, input.candidateOverride);
  const existingIds = pending.frontmatter.existing?.ids ?? [];
  // 版本迁移：新版继承被 supersede 旧版的 activation（保留用户对原记忆按用途的精调）。
  // 无旧版（纯新记忆接受低置信度等）→ writeEntry 默认 DEFAULT_ACTIVATION。
  const supersededEntry = existingIds.length > 0
    ? findEntryByIdAcrossScopes(existingIds[0]!, input.workspaceSlug)
    : undefined;
  const entry = writeEntry(candidate, {
    supersedes: existingIds,
    source: {
      type: "manual",
      run_id: pending.frontmatter.evidence?.run_id,
      record_ids: pending.frontmatter.evidence?.record_ids
    },
    evidenceRefs: pending.frontmatter.evidence_refs,
    ...(supersededEntry ? { activation: readActivation(supersededEntry.frontmatter) } : {})
  });
  for (const existingId of existingIds) {
    const existing = findEntryByIdAcrossScopes(existingId, input.workspaceSlug);
    if (!existing) continue;
    updateEntryStatus({
      scope: existing.frontmatter.scope,
      workspaceSlug: input.workspaceSlug,
      id: existing.frontmatter.id,
      status: "superseded",
      supersededBy: entry.frontmatter.id
    });
  }
  updatePendingStatus(pending, "resolved");
  return {
    ok: true,
    id: pending.frontmatter.id,
    path: pending.path,
    entryId: entry.frontmatter.id,
    entryPath: entry.path
  };
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

export function readPendingFile(path: string): MemoryV2PendingItem {
  const { frontmatter, body } = parseMarkdownDocument<MemoryV2PendingFrontmatter>(readFileSync(path, "utf-8"));
  return {
    frontmatter: normalizePendingFrontmatter(frontmatter, path),
    body: body.trim(),
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

/**
 * 读取激活开关。fail-open：frontmatter 无 activation 字段时返回 DEFAULT_ACTIVATION（全 true），
 * 以兼容 Task 1 之前写入的旧记忆。
 *
 * 按键 fallback：手编辑 YAML 产生 partial activation（如仅 {recall: true}）时，
 * 缺失键以 DEFAULT_ACTIVATION 对应值补齐（默认 true），与 UI 的逐键合并行为保持一致。
 */
export function readActivation(frontmatter: Pick<MemoryV2EntryFrontmatter, "activation">): MemoryV2Activation {
  return { ...DEFAULT_ACTIVATION, ...(frontmatter.activation ?? {}) };
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
  const paths = getMemoryV2ScopePaths({ scope: input.scope, workspaceSlug: input.workspaceSlug });
  const file = listMarkdownFiles(paths.entriesDir).find((path) => entryFileId(path) === input.id);
  if (!file) return undefined;
  try {
    return readEntryFile(file);
  } catch {
    return undefined;
  }
}

function findEntryByIdAcrossScopes(id: string, workspaceSlug?: string): MemoryV2Entry | undefined {
  for (const scope of ["global", "workspace"] as const) {
    if (scope === "workspace" && !workspaceSlug) continue;
    const paths = getMemoryV2ScopePaths({ scope, workspaceSlug });
    const file = listMarkdownFiles(paths.entriesDir).find((path) => entryFileId(path) === id);
    if (file) {
      try {
        return readEntryFile(file);
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function removeEntryReferences(id: string, workspaceSlug?: string): void {
  for (const entry of listEntries({
    workspaceSlug,
    scopes: ["global", "workspace"],
    includeStatuses: ALL_ENTRY_STATUSES
  })) {
    const related = entry.frontmatter.related.filter((value) => value !== id);
    const supersedes = entry.frontmatter.supersedes.filter((value) => value !== id);
    const supersededBy = entry.frontmatter.superseded_by === id ? null : entry.frontmatter.superseded_by;
    if (
      related.length === entry.frontmatter.related.length
      && supersedes.length === entry.frontmatter.supersedes.length
      && supersededBy === entry.frontmatter.superseded_by
    ) {
      continue;
    }
    writeMarkdownDocument(entry.path, {
      ...entry.frontmatter,
      related,
      supersedes,
      superseded_by: supersededBy,
      updated: new Date().toISOString()
    }, entry.statement);
  }
}

function findPendingByPath(input: {
  workspaceSlug: string;
  path: string;
}): MemoryV2PendingItem | undefined {
  return listPending({
    workspaceSlug: input.workspaceSlug,
    scopes: ["global", "workspace"]
  }).find((item) => item.path === input.path);
}

function candidateFromPending(
  item: MemoryV2PendingItem,
  workspaceSlug: string,
  override?: {
    statement?: string;
    kind?: MemoryV2EntryFrontmatter["kind"];
    confidence?: MemoryV2EntryFrontmatter["confidence"];
    tags?: string[];
  }
): MemoryV2Candidate {
  const targetScope = item.frontmatter.candidate.targetScope;
  const appliesWhen = item.frontmatter.candidate.appliesWhen ?? {};
  const statement = override?.statement === undefined
    ? item.frontmatter.candidate.statement
    : override.statement.trim();
  if (!statement) {
    throw new Error("Memory pending candidate statement cannot be empty");
  }
  return {
    kind: override?.kind ?? item.frontmatter.candidate.kind,
    semanticRole: item.frontmatter.candidate.semantic_role,
    targetScope,
    statement,
    confidence: override?.confidence ?? item.frontmatter.candidate.confidence ?? "medium",
    tags: override?.tags === undefined ? item.frontmatter.candidate.tags : cleanList(override.tags),
    facets: item.frontmatter.candidate.facets,
    entities: item.frontmatter.candidate.entities,
    appliesWhen: targetScope === "workspace" && !appliesWhen.workspaceSlug
      ? { ...appliesWhen, workspaceSlug }
      : appliesWhen,
    claim: item.frontmatter.candidate.claim,
    evidence: item.frontmatter.evidence
      ? {
          runId: item.frontmatter.evidence.run_id,
          recordIds: item.frontmatter.evidence.record_ids
        }
      : undefined,
    evidenceRefs: item.frontmatter.evidence_refs
  };
}

function updatePendingStatus(
  item: MemoryV2PendingItem,
  status: MemoryV2PendingFrontmatter["status"]
): MemoryV2PendingItem {
  const next: MemoryV2PendingItem = {
    ...item,
    frontmatter: {
      ...item.frontmatter,
      status
    }
  };
  writeMarkdownDocument(next.path, next.frontmatter, next.body);
  return next;
}

function normalizeEntryFrontmatter(raw: MemoryV2EntryFrontmatter, path: string): MemoryV2EntryFrontmatter {
  if (!raw.id || !raw.kind || !raw.scope) {
    throw new Error(`Invalid memory entry frontmatter: ${path}`);
  }
  return {
    ...raw,
    kind: raw.kind ?? kindFromSemanticRole(raw.semantic_role),
    semantic_role: raw.semantic_role ?? semanticRoleFromKind(raw.kind, raw.tags),
    facets: cleanList(raw.facets ?? raw.tags),
    tags: cleanList(raw.tags),
    entities: cleanList(raw.entities),
    related: cleanList(raw.related),
    supersedes: cleanList(raw.supersedes),
    superseded_by: raw.superseded_by ?? null,
    applies_when: raw.applies_when ?? {},
    valid_from: raw.valid_from ?? null,
    valid_to: raw.valid_to ?? null,
    pinned: Boolean(raw.pinned),
    revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
    last_confirmed_at: raw.last_confirmed_at ?? raw.updated ?? raw.created,
    evidence_refs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs : evidenceRefsFromSource(raw.source),
    claim: normalizeMemoryV2Claim(raw.claim)
  };
}

function normalizePendingFrontmatter(raw: MemoryV2PendingFrontmatter, path: string): MemoryV2PendingFrontmatter {
  if (!raw.id || !raw.type || !raw.candidate) {
    throw new Error(`Invalid memory pending frontmatter: ${path}`);
  }
  return {
    ...raw,
    candidate: {
      ...raw.candidate,
      tags: cleanList(raw.candidate.tags),
      facets: cleanList(raw.candidate.facets),
      entities: cleanList(raw.candidate.entities),
      appliesWhen: raw.candidate.appliesWhen ?? {},
      claim: normalizeMemoryV2Claim(raw.candidate.claim)
    },
    existing: raw.existing?.ids?.length ? { ids: cleanList(raw.existing.ids) } : undefined,
    evidence: raw.evidence ?? undefined,
    evidence_refs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs : undefined,
    status: raw.status ?? "open"
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

/** entry 文件名格式 {YYYY-MM-DD}-{id}.md；去掉 .md 后缀与 10 字符 date 前缀（+"-"）得 id。 */
function entryFileId(path: string): string {
  return basename(path, ".md").slice(11);
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

function evidenceRefsFromCandidate(candidate: MemoryV2Candidate): MemoryV2EvidenceRef[] {
  if (candidate.evidenceRefs?.length) return uniqueEvidenceRefs(candidate.evidenceRefs);
  const refs: MemoryV2EvidenceRef[] = [];
  for (const id of candidate.evidence?.recordIds ?? []) {
    refs.push({ type: "user_message", id, runId: candidate.evidence?.runId });
  }
  for (const path of candidate.evidence?.sourcePaths ?? []) {
    refs.push({ type: "external_file", path, runId: candidate.evidence?.runId });
  }
  if (refs.length === 0) refs.push({ type: "manual", runId: candidate.evidence?.runId });
  return refs;
}

function evidenceRefsFromSource(source: MemoryV2Source): MemoryV2EvidenceRef[] {
  if (source.path) return [{ type: "external_file", path: source.path, runId: source.run_id }];
  if (source.record_ids?.length) {
    return source.record_ids.map((id) => ({ type: "user_message", id, runId: source.run_id }));
  }
  return [{ type: "manual", runId: source.run_id }];
}

function semanticRoleFromKind(kind?: MemoryV2Kind, tags?: string[]): MemoryV2SemanticRole {
  if ((tags ?? []).some((tag) => ["identity", "preferred-name", "profile"].includes(tag))) return "identity";
  if (kind === "preference" || kind === "decision" || kind === "lesson" || kind === "state") return kind;
  return "fact";
}

function kindFromSemanticRole(role?: MemoryV2SemanticRole): MemoryV2Kind {
  if (role === "preference" || role === "decision" || role === "lesson" || role === "state") return role;
  return "fact";
}

function assertRevision(entry: MemoryV2Entry, expectedRevision?: number): void {
  if (expectedRevision !== undefined && entry.frontmatter.revision !== expectedRevision) {
    throw new Error(`Memory revision conflict: expected ${expectedRevision}, got ${entry.frontmatter.revision}`);
  }
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
