import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  MemoryItem,
  MemoryKind,
  MemoryScope,
  MemorySearchInput,
  MemorySearchResult,
  MemorySource
} from "@lume/shared";
import { buildFtsQuery, bm25RankToScore } from "./hybrid-search";
import { initializeStructuredMemoryDb } from "./memory-db";

type MemoryItemInput = Omit<MemoryItem, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
};

interface MemoryItemRow {
  id: string;
  workspace_slug: string;
  scope: string;
  kind: string;
  source: string;
  title?: string | null;
  content: string;
  summary?: string | null;
  source_path?: string | null;
  source_session_id?: string | null;
  source_message_ids?: string | null;
  source_tool_call_id?: string | null;
  tags?: string | null;
  entities?: string | null;
  topics?: string | null;
  importance: number;
  confidence: number;
  valid_from?: number | null;
  valid_to?: number | null;
  supersedes?: string | null;
  superseded_by?: string | null;
  promoted_from?: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryAuditLogEntry {
  id: string;
  workspaceSlug: string;
  operation: string;
  memoryId?: string;
  actor?: string;
  reason?: string;
  beforeJson?: string;
  afterJson?: string;
  createdAt: number;
}

function encodeJson(value: string[] | undefined): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null;
}

function decodeJsonArray(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // ignore
  }
  return undefined;
}

function decodePromotedFrom(value: string | null | undefined): MemoryItem["promotedFrom"] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as { workspaceSlug?: unknown; memoryIds?: unknown; reason?: unknown };
    if (typeof record.workspaceSlug !== "string" || typeof record.reason !== "string" || !Array.isArray(record.memoryIds)) {
      return undefined;
    }
    const memoryIds = record.memoryIds.filter((item): item is string => typeof item === "string");
    return {
      workspaceSlug: record.workspaceSlug,
      memoryIds,
      reason: record.reason
    };
  } catch {
    return undefined;
  }
}

function clampImportance(value: number | undefined): 1 | 2 | 3 | 4 | 5 {
  const n = Math.round(value ?? 3);
  return Math.min(5, Math.max(1, n)) as 1 | 2 | 3 | 4 | 5;
}

function normalizeConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function rowToItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    workspaceSlug: row.workspace_slug,
    scope: row.scope as MemoryScope,
    kind: row.kind as MemoryKind,
    source: row.source as MemorySource,
    ...(row.title ? { title: row.title } : {}),
    content: row.content,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.source_path ? { sourcePath: row.source_path } : {}),
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    ...(decodeJsonArray(row.source_message_ids) ? { sourceMessageIds: decodeJsonArray(row.source_message_ids) } : {}),
    ...(row.source_tool_call_id ? { sourceToolCallId: row.source_tool_call_id } : {}),
    ...(decodeJsonArray(row.tags) ? { tags: decodeJsonArray(row.tags) } : {}),
    ...(decodeJsonArray(row.entities) ? { entities: decodeJsonArray(row.entities) } : {}),
    ...(decodeJsonArray(row.topics) ? { topics: decodeJsonArray(row.topics) } : {}),
    importance: clampImportance(row.importance),
    confidence: normalizeConfidence(row.confidence),
    ...(row.valid_from ? { validFrom: row.valid_from } : {}),
    ...(row.valid_to ? { validTo: row.valid_to } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(decodePromotedFrom(row.promoted_from) ? { promotedFrom: decodePromotedFrom(row.promoted_from) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

type SqlParam = string | number | boolean | null;

function buildInFilter(column: string, values: string[] | undefined, params: SqlParam[]): string {
  if (!values || values.length === 0) return "";
  const placeholders = values.map(() => "?").join(", ");
  params.push(...values);
  return ` AND ${column} IN (${placeholders})`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class MemoryRepository {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private readonly workspaceSlug: string;
  private ftsEnabled = true;

  constructor(params: {
    db?: Database;
    dbPath?: string;
    workspaceSlug: string;
  }) {
    if (params.db) {
      this.db = params.db;
      this.ownsDb = false;
    } else if (params.dbPath) {
      this.db = new Database(params.dbPath, { create: true, strict: true });
      this.ownsDb = true;
    } else {
      throw new Error("MemoryRepository requires db or dbPath");
    }
    this.workspaceSlug = params.workspaceSlug;
    initializeStructuredMemoryDb(this.db);
    try {
      this.db.query("SELECT id FROM memory_items_fts LIMIT 0").all();
    } catch {
      this.ftsEnabled = false;
    }
  }

  dispose(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  private insertFts(item: MemoryItem): void {
    if (!this.ftsEnabled) return;
    try {
      this.db
        .query(
          `INSERT OR REPLACE INTO memory_items_fts
           (id, workspace_slug, title, content, summary, tags, topics)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .run(
          item.id,
          item.workspaceSlug,
          item.title ?? "",
          item.content,
          item.summary ?? "",
          (item.tags ?? []).join(" "),
          (item.topics ?? []).join(" ")
        );
    } catch {
      this.ftsEnabled = false;
    }
  }

  private removeFts(id: string): void {
    if (!this.ftsEnabled) return;
    try {
      this.db.query("DELETE FROM memory_items_fts WHERE id = ?1").run(id);
    } catch {
      this.ftsEnabled = false;
    }
  }

  private writeAudit(params: {
    operation: string;
    memoryId?: string;
    before?: unknown;
    after?: unknown;
    actor?: string;
    reason?: string;
  }): void {
    this.db
      .query(
        `INSERT INTO memory_audit_log
         (id, workspace_slug, operation, memory_id, actor, reason, before_json, after_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .run(
        randomUUID(),
        this.workspaceSlug,
        params.operation,
        params.memoryId ?? null,
        params.actor ?? "system",
        params.reason ?? null,
        params.before ? JSON.stringify(params.before) : null,
        params.after ? JSON.stringify(params.after) : null,
        Date.now()
      );
  }

  async save(input: MemoryItemInput): Promise<MemoryItem> {
    const now = Date.now();
    const item: MemoryItem = {
      ...input,
      id: input.id ?? randomUUID(),
      workspaceSlug: input.workspaceSlug || this.workspaceSlug,
      importance: clampImportance(input.importance),
      confidence: normalizeConfidence(input.confidence),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now
    };

    this.db.transaction(() => {
      this.db
        .query(
          `INSERT OR REPLACE INTO memory_items (
            id, workspace_slug, scope, kind, source,
            title, content, summary,
            source_path, source_session_id, source_message_ids, source_tool_call_id,
            tags, entities, topics,
            importance, confidence,
            valid_from, valid_to, supersedes, superseded_by, promoted_from,
            created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8,
            ?9, ?10, ?11, ?12,
            ?13, ?14, ?15,
            ?16, ?17,
            ?18, ?19, ?20, ?21, ?22,
            ?23, ?24
          )`
        )
        .run(
          item.id,
          item.workspaceSlug,
          item.scope,
          item.kind,
          item.source,
          item.title ?? null,
          item.content,
          item.summary ?? null,
          item.sourcePath ?? null,
          item.sourceSessionId ?? null,
          encodeJson(item.sourceMessageIds),
          item.sourceToolCallId ?? null,
          encodeJson(item.tags),
          encodeJson(item.entities),
          encodeJson(item.topics),
          item.importance,
          item.confidence,
          item.validFrom ?? null,
          item.validTo ?? null,
          item.supersedes ?? null,
          item.supersededBy ?? null,
          item.promotedFrom ? JSON.stringify(item.promotedFrom) : null,
          item.createdAt,
          item.updatedAt
        );
      this.insertFts(item);
      this.writeAudit({ operation: "save", memoryId: item.id, after: item });
    })();

    return item;
  }

  async update(id: string, patch: Partial<MemoryItem>): Promise<MemoryItem> {
    const current = await this.get(id);
    if (!current) {
      throw new Error(`记忆不存在: ${id}`);
    }
    const next: MemoryItem = {
      ...current,
      ...patch,
      id,
      workspaceSlug: patch.workspaceSlug ?? current.workspaceSlug,
      importance: clampImportance(patch.importance ?? current.importance),
      confidence: normalizeConfidence(patch.confidence ?? current.confidence),
      createdAt: current.createdAt,
      updatedAt: Date.now()
    };
    const saved = await this.save(next);
    this.writeAudit({ operation: "update", memoryId: id, before: current, after: saved });
    return saved;
  }

  async get(id: string): Promise<MemoryItem | null> {
    const row = this.db
      .query("SELECT * FROM memory_items WHERE id = ?1")
      .get(id) as MemoryItemRow | null;
    return row ? rowToItem(row) : null;
  }

  async listByWorkspace(workspaceSlug = this.workspaceSlug): Promise<MemoryItem[]> {
    const rows = this.db
      .query("SELECT * FROM memory_items WHERE workspace_slug = ?1 ORDER BY updated_at DESC")
      .all(workspaceSlug) as MemoryItemRow[];
    return rows.map(rowToItem);
  }

  async delete(id: string): Promise<void> {
    const before = await this.get(id);
    this.db.transaction(() => {
      this.removeFts(id);
      this.db.query("DELETE FROM memory_items WHERE id = ?1").run(id);
      this.writeAudit({ operation: "delete", memoryId: id, before });
    })();
  }

  async invalidate(id: string, validTo = Date.now()): Promise<void> {
    const before = await this.get(id);
    if (!before) return;
    this.db
      .query("UPDATE memory_items SET valid_to = ?1, updated_at = ?2 WHERE id = ?3")
      .run(validTo, Date.now(), id);
    const after = await this.get(id);
    this.writeAudit({ operation: "invalidate", memoryId: id, before, after });
  }

  async search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    const query = input.query.trim();
    if (!query) return [];
    const maxResults = Math.max(1, Math.min(50, input.maxResults ?? 10));
    const params: SqlParam[] = [input.workspaceSlug || this.workspaceSlug];
    let filters = " AND (mi.valid_to IS NULL OR mi.valid_to > ?)";
    params.push(Date.now());
    filters += buildInFilter("mi.scope", input.scopes, params);
    filters += buildInFilter("mi.kind", input.kinds, params);
    filters += buildInFilter("mi.source", input.sources, params);

    const rows: Array<MemoryItemRow & { rank?: number }> = [];
    const ftsQuery = buildFtsQuery(query);
    if (this.ftsEnabled && ftsQuery) {
      try {
        rows.push(
          ...(this.db
            .query(
              `SELECT mi.*, memory_items_fts.rank AS rank
               FROM memory_items_fts
               JOIN memory_items mi ON mi.id = memory_items_fts.id
               WHERE memory_items_fts MATCH ?
                 AND mi.workspace_slug = ? ${filters}
               ORDER BY memory_items_fts.rank
               LIMIT ?`
            )
            .all(ftsQuery, ...params, maxResults) as Array<MemoryItemRow & { rank?: number }>)
        );
      } catch {
        this.ftsEnabled = false;
      }
    }

    if (rows.length === 0) {
      const words = query.split(/\s+/).filter(Boolean).slice(0, 5);
      const likeParams = words.map((word) => `%${escapeLike(word)}%`);
      const likeWhere = words
        .map(() => "(mi.title LIKE ? ESCAPE '\\' OR mi.content LIKE ? ESCAPE '\\' OR mi.summary LIKE ? ESCAPE '\\')")
        .join(" OR ");
      const expandedLikeParams = likeParams.flatMap((value) => [value, value, value]);
      rows.push(
        ...(this.db
          .query(
            `SELECT mi.*
             FROM memory_items mi
             WHERE mi.workspace_slug = ? ${filters}
               AND (${likeWhere})
             ORDER BY mi.updated_at DESC
             LIMIT ?`
          )
          .all(...params, ...expandedLikeParams, maxResults) as MemoryItemRow[])
      );
    }

    const now = Date.now();
    const monthMs = 30 * 24 * 60 * 60 * 1000;
    return rows.slice(0, maxResults).map((row) => {
      const item = rowToItem(row);
      const keywordScore = typeof row.rank === "number" ? bm25RankToScore(Math.abs(row.rank)) : 0.7;
      const recencyScore = Math.max(0, 1 - (now - item.updatedAt) / monthMs);
      const importanceScore = item.importance / 5;
      const score = keywordScore * 0.7 + recencyScore * 0.15 + importanceScore * 0.15;
      return {
        id: item.id,
        path: item.sourcePath ?? "",
        snippet: item.summary || item.content,
        score,
        keywordScore,
        recencyScore,
        importanceScore,
        kind: item.kind,
        scope: item.scope,
        source: item.source,
        reason: "structured-memory"
      };
    });
  }

  listAuditLog(): MemoryAuditLogEntry[] {
    const rows = this.db
      .query("SELECT * FROM memory_audit_log WHERE workspace_slug = ?1 ORDER BY created_at ASC")
      .all(this.workspaceSlug) as Array<{
        id: string;
        workspace_slug: string;
        operation: string;
        memory_id?: string | null;
        actor?: string | null;
        reason?: string | null;
        before_json?: string | null;
        after_json?: string | null;
        created_at: number;
      }>;

    return rows.map((row) => ({
      id: row.id,
      workspaceSlug: row.workspace_slug,
      operation: row.operation,
      ...(row.memory_id ? { memoryId: row.memory_id } : {}),
      ...(row.actor ? { actor: row.actor } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.before_json ? { beforeJson: row.before_json } : {}),
      ...(row.after_json ? { afterJson: row.after_json } : {}),
      createdAt: row.created_at
    }));
  }
}
