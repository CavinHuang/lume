import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
  GlobalMemoryCandidate,
  MemoryItem,
  MemoryKind,
  MemorySearchResult,
  PromoteGlobalMemoryInput
} from "@lume/shared";
import {
  getGlobalStructuredMemoryDbPath,
  getGlobalStructuredMemoryPath,
  getWorkspaceMemoryDbPath
} from "../infra/config-paths";
import { initializeGlobalMemoryDb } from "./memory-global-db";
import { MemoryRepository } from "./memory-repository";

const GLOBAL_WORKSPACE_SLUG = "__global__";

interface CandidateRow {
  id: string;
  workspace_slug: string;
  memory_ids: string;
  kind: string;
  title?: string | null;
  content: string;
  reason: string;
  confidence: number;
  importance: number;
  status: string;
  created_at: number;
  updated_at: number;
}

function clampImportance(value: number): 1 | 2 | 3 | 4 | 5 {
  return Math.min(5, Math.max(1, Math.round(value))) as 1 | 2 | 3 | 4 | 5;
}

function rowToCandidate(row: CandidateRow): GlobalMemoryCandidate {
  let memoryIds: string[] = [];
  try {
    const parsed = JSON.parse(row.memory_ids) as unknown;
    if (Array.isArray(parsed)) {
      memoryIds = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    memoryIds = [];
  }
  return {
    id: row.id,
    workspaceSlug: row.workspace_slug,
    memoryIds,
    kind: row.kind as MemoryKind,
    ...(row.title ? { title: row.title } : {}),
    content: row.content,
    reason: row.reason,
    confidence: row.confidence,
    importance: clampImportance(row.importance),
    status: row.status as GlobalMemoryCandidate["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getGlobalDb(): Database {
  const db = new Database(getGlobalStructuredMemoryDbPath(), { create: true, strict: true });
  initializeGlobalMemoryDb(db);
  return db;
}

function isPromotable(item: MemoryItem): boolean {
  if (!["preference", "lesson", "fact"].includes(item.kind)) return false;
  if (item.importance < 4 || item.confidence < 0.75) return false;
  const text = `${item.title ?? ""} ${item.content}`.toLowerCase();
  if (/\b(branch|workspace|page|component|PR|issue)\b/i.test(text)) return false;
  return true;
}

function candidateReason(item: MemoryItem): string {
  return `Promotable ${item.kind} from workspace memory with importance ${item.importance} and confidence ${item.confidence}.`;
}

function findExistingCandidate(db: Database, workspaceSlug: string, content: string): GlobalMemoryCandidate | null {
  const row = db
    .query("SELECT * FROM global_memory_candidates WHERE workspace_slug = ?1 AND content = ?2 LIMIT 1")
    .get(workspaceSlug, content) as CandidateRow | null;
  return row ? rowToCandidate(row) : null;
}

function insertCandidate(db: Database, item: MemoryItem): GlobalMemoryCandidate {
  const now = Date.now();
  const candidate: GlobalMemoryCandidate = {
    id: randomUUID(),
    workspaceSlug: item.workspaceSlug,
    memoryIds: [item.id],
    kind: item.kind,
    ...(item.title ? { title: item.title } : {}),
    content: item.summary || item.content,
    reason: candidateReason(item),
    confidence: item.confidence,
    importance: item.importance,
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
  db.query(
    `INSERT INTO global_memory_candidates
     (id, workspace_slug, memory_ids, kind, title, content, reason, confidence, importance, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  ).run(
    candidate.id,
    candidate.workspaceSlug,
    JSON.stringify(candidate.memoryIds),
    candidate.kind,
    candidate.title ?? null,
    candidate.content,
    candidate.reason,
    candidate.confidence,
    candidate.importance,
    candidate.status,
    candidate.createdAt,
    candidate.updatedAt
  );
  return candidate;
}

function updateCandidateStatus(db: Database, id: string, status: GlobalMemoryCandidate["status"]): GlobalMemoryCandidate {
  db.query("UPDATE global_memory_candidates SET status = ?1, updated_at = ?2 WHERE id = ?3")
    .run(status, Date.now(), id);
  const row = db.query("SELECT * FROM global_memory_candidates WHERE id = ?1").get(id) as CandidateRow | null;
  if (!row) {
    throw new Error(`全局记忆候选不存在: ${id}`);
  }
  return rowToCandidate(row);
}

function getCandidate(db: Database, id: string): GlobalMemoryCandidate {
  const row = db.query("SELECT * FROM global_memory_candidates WHERE id = ?1").get(id) as CandidateRow | null;
  if (!row) {
    throw new Error(`全局记忆候选不存在: ${id}`);
  }
  return rowToCandidate(row);
}

function appendGlobalMarkdown(item: MemoryItem): void {
  const path = getGlobalStructuredMemoryPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const title = item.title ? ` ${item.title}` : "";
  appendFileSync(path, `\n## ${new Date(item.createdAt).toISOString()}\n- [${item.kind}]${title}: ${item.content}\n`, "utf-8");
}

export async function generateGlobalCandidates(input: {
  workspaceSlug: string;
  memoryIds: string[];
}): Promise<GlobalMemoryCandidate[]> {
  const workspaceRepository = new MemoryRepository({
    dbPath: getWorkspaceMemoryDbPath(input.workspaceSlug),
    workspaceSlug: input.workspaceSlug
  });
  const globalDb = getGlobalDb();
  try {
    const candidates: GlobalMemoryCandidate[] = [];
    for (const memoryId of input.memoryIds) {
      const item = await workspaceRepository.get(memoryId);
      if (!item || !isPromotable(item)) continue;
      const existing = findExistingCandidate(globalDb, input.workspaceSlug, item.summary || item.content);
      candidates.push(existing ?? insertCandidate(globalDb, item));
    }
    return candidates;
  } finally {
    workspaceRepository.dispose();
    globalDb.close();
  }
}

export async function listGlobalMemoryCandidates(input: {
  status?: GlobalMemoryCandidate["status"];
} = {}): Promise<GlobalMemoryCandidate[]> {
  const db = getGlobalDb();
  try {
    const rows = input.status
      ? db.query("SELECT * FROM global_memory_candidates WHERE status = ?1 ORDER BY updated_at DESC").all(input.status)
      : db.query("SELECT * FROM global_memory_candidates ORDER BY updated_at DESC").all();
    return (rows as CandidateRow[]).map(rowToCandidate);
  } finally {
    db.close();
  }
}

export async function promoteGlobalMemory(input: PromoteGlobalMemoryInput): Promise<MemoryItem> {
  const db = getGlobalDb();
  const repository = new MemoryRepository({
    db,
    workspaceSlug: GLOBAL_WORKSPACE_SLUG
  });
  try {
    const candidate = getCandidate(db, input.candidateId);
    if (!input.approve) {
      updateCandidateStatus(db, candidate.id, "rejected");
      throw new Error("候选未批准，未提升为全局记忆");
    }
    const content = input.editedContent?.trim() || candidate.content;
    const item = await repository.save({
      workspaceSlug: GLOBAL_WORKSPACE_SLUG,
      scope: "global",
      kind: candidate.kind,
      source: "promotion",
      title: candidate.title,
      content,
      importance: candidate.importance,
      confidence: candidate.confidence,
      promotedFrom: {
        workspaceSlug: candidate.workspaceSlug,
        memoryIds: candidate.memoryIds,
        reason: candidate.reason
      }
    });
    appendGlobalMarkdown(item);
    updateCandidateStatus(db, candidate.id, "approved");
    return item;
  } finally {
    repository.dispose();
    db.close();
  }
}

export async function rejectGlobalMemoryCandidate(candidateId: string): Promise<GlobalMemoryCandidate> {
  const db = getGlobalDb();
  try {
    return updateCandidateStatus(db, candidateId, "rejected");
  } finally {
    db.close();
  }
}

export async function searchGlobalMemory(input: {
  query: string;
  maxResults?: number;
}): Promise<MemorySearchResult[]> {
  const repository = new MemoryRepository({
    dbPath: getGlobalStructuredMemoryDbPath(),
    workspaceSlug: GLOBAL_WORKSPACE_SLUG
  });
  try {
    return repository.search({
      workspaceSlug: GLOBAL_WORKSPACE_SLUG,
      query: input.query,
      maxResults: input.maxResults,
      scopes: ["global"]
    });
  } finally {
    repository.dispose();
  }
}

export function getGlobalMemoryStatus(): {
  workspaceSlug: string;
  candidateCount: number;
  pendingCandidateCount: number;
  itemCount: number;
} {
  const db = getGlobalDb();
  const repository = new MemoryRepository({ db, workspaceSlug: GLOBAL_WORKSPACE_SLUG });
  try {
    const candidateCount = (db.query("SELECT COUNT(*) AS count FROM global_memory_candidates").get() as { count: number }).count;
    const pendingCandidateCount = (db.query("SELECT COUNT(*) AS count FROM global_memory_candidates WHERE status = 'pending'").get() as { count: number }).count;
    const itemCount = (db.query("SELECT COUNT(*) AS count FROM memory_items WHERE workspace_slug = ?1").get(GLOBAL_WORKSPACE_SLUG) as { count: number }).count;
    return {
      workspaceSlug: GLOBAL_WORKSPACE_SLUG,
      candidateCount,
      pendingCandidateCount,
      itemCount
    };
  } finally {
    repository.dispose();
    db.close();
  }
}
