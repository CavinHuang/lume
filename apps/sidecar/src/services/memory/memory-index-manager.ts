import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { Database } from "bun:sqlite";
import {
  DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_INDEX_CONCURRENCY,
  SNIPPET_MAX_CHARS,
  DEFAULT_TEXT_WEIGHT,
  DEFAULT_VECTOR_WEIGHT
} from "./constants";
import { chunkMarkdown, remapChunkLines } from "./memory-chunker";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid-search";
import {
  createLiteEmbedding,
  embedTextWithProvider,
  embedTextsWithProvider,
  resolveEmbeddingProvider,
  type ResolvedEmbeddingProvider,
  embedTextWithCache,
  embedTextsWithCache
} from "./embedding";
import { ensureInsideRoot, ensurePathAllowed } from "./memory-path-utils";
import { searchDenseFallbackRows, searchKeywordRows, searchVectorRows } from "./search-ops";
import {
  countChunksBySource,
  countChunksForWorkspace,
  countFilesBySource,
  countFilesForWorkspace
} from "./status-ops";
import { collectWorkspaceMemoryEntries, pruneStaleIndexedRows, type SyncTargetEntry } from "./sync-ops";
import type { HybridSearchResult } from "./types";
import { listThreadEntriesForWorkspace } from "../session/thread-files";
import {
  isMarkdownFile,
  isMemoryPath,
  normalizeExtraMemoryPaths
} from "./memory-path-utils";
import type {
  MemoryGetResult,
  MemorySearchResult,
  MemorySaveResult,
  MemoryStats
} from "@lume/shared";

interface FileMetaRow {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  source?: string;
}

const SQLITE_VEC_DIMS_DEFAULT = 1536;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function vectorToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function truncateUtf16Safe(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return input.slice(0, Math.max(0, maxChars));
}

function formatCitation(path: string, startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `${path}#L${startLine}`;
  }
  return `${path}#L${startLine}-L${endLine}`;
}

export class MemoryIndexManager {
  private readonly db: Database;
  private readonly dbPath: string;
  private readonly workspaceRoot: string;
  private readonly workspaceSlug: string;
  private readonly ftsEnabled: boolean;
  private vecEnabled: boolean;
  private vecSearchReady: boolean;
  private vecDims: number;
  private readonly embedding: ResolvedEmbeddingProvider;
  private readonly sources: Set<"memory" | "sessions">;
  private readonly extraPaths: string[];
  private readonly workspaceId?: string;

  constructor(params: {
    workspaceRoot: string;
    workspaceSlug: string;
    dbPath: string;
    workspaceId?: string;
    sources?: Array<"memory" | "sessions">;
    extraPaths?: string[];
  }) {
    this.workspaceRoot = resolve(params.workspaceRoot);
    this.workspaceSlug = params.workspaceSlug;
    this.dbPath = params.dbPath;
    this.workspaceId = params.workspaceId;
    this.sources = new Set((params.sources ?? ["memory"]).filter((item) => item === "memory" || item === "sessions"));
    if (this.sources.size === 0) this.sources.add("memory");
    this.extraPaths = normalizeExtraMemoryPaths(this.workspaceRoot, params.extraPaths ?? []);
    this.db = new Database(params.dbPath, { create: true, strict: true });
    this.embedding = resolveEmbeddingProvider();

    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA mmap_size = 8388608;");
    this.db.exec("PRAGMA cache_size = -2000;");
    this.db.exec("PRAGMA temp_store = MEMORY;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        workspace_slug TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embedding_cache (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
    `);

    let ftsEnabled = true;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text,
          id UNINDEXED,
          path UNINDEXED,
          workspace_slug UNINDEXED,
          source UNINDEXED,
          model UNINDEXED,
          start_line UNINDEXED,
          end_line UNINDEXED
        );
      `);
    } catch (error) {
      console.warn("[记忆索引] FTS5 不可用，将跳过关键词搜索:", error);
      ftsEnabled = false;
    }
    this.ftsEnabled = ftsEnabled;

    let vecEnabled = true;
    // 从 meta 表读取已存储的维度，避免重建时维度不匹配
    const storedDims = (() => {
      try {
        const row = this.db.query("SELECT value FROM meta WHERE key = 'vec_dims'").get() as { value?: string } | null;
        const n = parseInt(row?.value ?? "", 10);
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch { return null; }
    })();
    const vecDims = storedDims ?? SQLITE_VEC_DIMS_DEFAULT;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${vecDims}]
        );
      `);
      // 某些环境会在 CREATE 阶段不报错，但首次访问时报 "no such table/module"。
      this.db.query("SELECT id FROM chunks_vec LIMIT 0").all();
    } catch {
      vecEnabled = false;
    }
    this.vecEnabled = vecEnabled;
    this.vecSearchReady = vecEnabled;
    this.vecDims = vecDims;
  }

  dispose(): void {
    this.db.close();
  }

  status(): {
    backend: "builtin";
    provider: string;
    model: string;
    files: number;
    chunks: number;
    workspaceDir: string;
    dbPath: string;
    sources: Array<"memory" | "sessions">;
    extraPaths: string[];
    sourceCounts: Array<{ source: "memory" | "sessions"; files: number; chunks: number }>;
    fallback?: { from?: string; reason?: string };
    ftsEnabled: boolean;
    vecEnabled: boolean;
  } {
    const sourceCounts = Array.from(this.sources).map((source) => {
      const dbSource = source === "sessions" ? "session" : "memory";
      return {
        source,
        files: countFilesBySource({
          db: this.db,
          workspaceSlug: this.workspaceSlug,
          dbSource
        }),
        chunks: countChunksBySource({
          db: this.db,
          workspaceSlug: this.workspaceSlug,
          dbSource
        })
      };
    });

    return {
      backend: "builtin",
      provider: this.embedding.provider,
      model: this.embedding.model,
      files: countFilesForWorkspace({
        db: this.db,
        workspaceSlug: this.workspaceSlug
      }),
      chunks: countChunksForWorkspace({
        db: this.db,
        workspaceSlug: this.workspaceSlug
      }),
      workspaceDir: this.workspaceRoot,
      dbPath: this.dbPath,
      sources: Array.from(this.sources),
      extraPaths: [...this.extraPaths],
      sourceCounts,
      ...(this.embedding.fallbackFrom || this.embedding.fallbackReason
        ? {
            fallback: {
              from: this.embedding.fallbackFrom,
              reason: this.embedding.fallbackReason
            }
          }
        : {}),
      ftsEnabled: this.ftsEnabled,
      vecEnabled: this.vecEnabled
    };
  }

  private buildDbSourceFilter(column: string): { sql: string; params: string[] } {
    const dbSources = Array.from(this.sources).map((source) =>
      source === "sessions" ? "session" : "memory"
    );
    if (dbSources.length === 0) {
      return { sql: "", params: [] };
    }
    const placeholders = dbSources.map(() => "?").join(", ");
    return {
      sql: ` AND ${column} IN (${placeholders})`,
      params: dbSources
    };
  }

  private getFileMeta(path: string): FileMetaRow | null {
    const row = this.db
      .query("SELECT path, hash, mtime, size FROM files WHERE path = ?1")
      .get(path) as FileMetaRow | null;
    return row;
  }

  private removeFileChunks(path: string): void {
    if (this.vecEnabled) {
      try {
        this.db.query(
          `DELETE FROM chunks_vec
           WHERE id IN (SELECT id FROM chunks WHERE path = ?1)`
        ).run(path);
      } catch {
        this.vecEnabled = false;
        this.vecSearchReady = false;
      }
    }
    this.db.query("DELETE FROM chunks WHERE path = ?1").run(path);
    if (this.ftsEnabled) {
      this.db.query("DELETE FROM chunks_fts WHERE path = ?1").run(path);
    }
  }

  removeFile(filePath: string): void {
    const resolvedPath = ensureInsideRoot(this.workspaceRoot, resolve(this.workspaceRoot, filePath));
    const relativePath = relative(this.workspaceRoot, resolvedPath).replace(/\\/g, "/");
    if (!isMemoryPath(relativePath)) {
      throw new Error("仅允许移除 MEMORY.md 或 memory/YYYY-MM-DD.md 的索引");
    }
    this.removeFileChunks(relativePath);
    this.db.query("DELETE FROM files WHERE path = ?1").run(relativePath);
  }

  private async indexContentEntry(entry: {
    source: "memory" | "session";
    logicalPath: string;
    absPath: string;
    content: string;
    mtimeMs: number;
    size: number;
    lineMap?: number[];
  }, force: boolean): Promise<number> {
    const hash = sha256(entry.content);
    const existing = this.getFileMeta(entry.logicalPath);
    if (!force && existing && existing.hash === hash && existing.mtime === entry.mtimeMs && existing.size === entry.size) {
      return 0;
    }

    const chunks = chunkMarkdown(entry.content, entry.logicalPath, { model: this.embedding.model });
    if (entry.source === "session") {
      remapChunkLines(chunks, entry.lineMap);
    }
    const now = Date.now();
    const embeddings = await this.embedTexts(chunks.map((chunk) => chunk.text));

    this.db.transaction(() => {
      this.removeFileChunks(entry.logicalPath);
      const insertChunk = this.db.query(
        `INSERT INTO chunks (
          id, path, workspace_slug, source, start_line, end_line, hash, model, text, embedding, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      );
      const insertFts = this.ftsEnabled
        ? this.db.query(
            `INSERT INTO chunks_fts (text, id, path, workspace_slug, source, model, start_line, end_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
          )
        : null;

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (!chunk) continue;
        const embedding = embeddings[i] ?? [];

        insertChunk.run(
          chunk.id,
          chunk.path,
          this.workspaceSlug,
          entry.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.embedding.model,
          chunk.text,
          JSON.stringify(embedding),
          now
        );

        if (this.vecEnabled && embedding.length > 0) {
          // 首次写入时动态更新维度
          if (embedding.length !== this.vecDims) {
            this.vecDims = embedding.length;
            try {
              this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('vec_dims', ?1)").run(String(this.vecDims));
            } catch { /* ignore */ }
          }
          if (embedding.length === this.vecDims) {
            try {
              this.db.query(
                `INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?1, ?2)`
              ).run(chunk.id, vectorToBlob(embedding));
            } catch {
              // vec0 写入失败不阻塞主流程
            }
          }
        }

        if (insertFts) {
          insertFts.run(
            chunk.text,
            chunk.id,
            chunk.path,
            this.workspaceSlug,
            entry.source,
            this.embedding.model,
            chunk.startLine,
            chunk.endLine
          );
        }
      }

      this.db.query(
        `INSERT OR REPLACE INTO files (path, workspace_slug, source, hash, mtime, size, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).run(entry.logicalPath, this.workspaceSlug, entry.source, hash, entry.mtimeMs, entry.size, now);
    })();

    return chunks.length;
  }

  private async embedText(text: string): Promise<number[]> {
    return embedTextWithCache({
      text,
      hashText: sha256,
      cache: {
        db: this.db,
        provider: this.embedding.provider,
        model: this.embedding.model,
        providerKey: this.embedding.providerKey
      },
      embedSingle: async (value) => {
        try {
          return await embedTextWithProvider(value, this.embedding);
        } catch (error) {
          console.warn("[记忆索引] 远程 embedding 失败，回退 Lite:", error);
          throw error;
        }
      },
      fallbackLite: (value) => createLiteEmbedding(value)
    });
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    return embedTextsWithCache({
      texts,
      hashText: sha256,
      cache: {
        db: this.db,
        provider: this.embedding.provider,
        model: this.embedding.model,
        providerKey: this.embedding.providerKey
      },
      embedBatch: async (batchTexts) => {
        try {
          return await embedTextsWithProvider(
            batchTexts,
            this.embedding,
            {
              concurrency: EMBEDDING_INDEX_CONCURRENCY,
              batchSize: EMBEDDING_BATCH_SIZE
            }
          );
        } catch (error) {
          console.warn("[记忆索引] batch embedding 失败，回退 Lite:", error);
          throw error;
        }
      },
      embedSingle: async (value) => embedTextWithProvider(value, this.embedding),
      fallbackLite: (value) => createLiteEmbedding(value)
    });
  }

  async indexFile(filePath: string, force = false): Promise<number> {
    const resolvedPath = ensureInsideRoot(this.workspaceRoot, resolve(this.workspaceRoot, filePath));
    const relativePath = relative(this.workspaceRoot, resolvedPath).replace(/\\/g, "/");
    if (!isMemoryPath(relativePath)) {
      return 0;
    }

    if (!existsSync(resolvedPath) || !isMarkdownFile(resolvedPath)) {
      return 0;
    }
    const st = lstatSync(resolvedPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return 0;
    }

    const stat = statSync(resolvedPath);
    const content = readFileSync(resolvedPath, "utf-8");
    return this.indexContentEntry(
      {
        source: "memory",
        logicalPath: relativePath,
        absPath: resolvedPath,
        content,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      },
      force
    );
  }

  async indexWorkspace(force = false): Promise<number> {
    const targetEntries: SyncTargetEntry[] = [];

    if (this.sources.has("memory")) {
      targetEntries.push(
        ...collectWorkspaceMemoryEntries({
          workspaceRoot: this.workspaceRoot,
          extraPaths: this.extraPaths
        })
      );
    }

    if (this.sources.has("sessions") && this.workspaceId) {
      for (const entry of listThreadEntriesForWorkspace(this.workspaceId)) {
        targetEntries.push({
          source: "session",
          logicalPath: entry.path,
          absPath: entry.absPath,
          content: entry.content,
          mtimeMs: entry.mtimeMs,
          size: entry.size,
          lineMap: entry.lineMap
        });
      }
    }

    let total = 0;
    for (const entry of targetEntries) {
      total += await this.indexContentEntry(entry, force);
    }

    const targetSet = new Set(targetEntries.map((item) => item.logicalPath));
    pruneStaleIndexedRows({
      db: this.db,
      workspaceSlug: this.workspaceSlug,
      targetPaths: targetSet,
      onDeletePath: (path) => {
        this.removeFileChunks(path);
      }
    });

    return total;
  }

  async search(input: {
    query: string;
    maxResults?: number;
    minScore?: number;
    queryEmbedding?: number[];
  }): Promise<MemorySearchResult[]> {
    const query = input.query.trim();
    if (!query) return [];

    const maxResults = Math.max(1, Math.min(50, input.maxResults ?? 10));
    const minScore = input.minScore ?? 0;
    const candidates = Math.min(200, maxResults * DEFAULT_HYBRID_CANDIDATE_MULTIPLIER);

    const keywordResults: HybridSearchResult[] = [];
    if (this.ftsEnabled) {
      const ftsQuery = buildFtsQuery(query);
      if (ftsQuery) {
        const sourceFilter = this.buildDbSourceFilter("source");
        const rows = searchKeywordRows({
          db: this.db,
          query: ftsQuery,
          candidates,
          sourceFilter
        });

        for (const row of rows) {
          keywordResults.push({
            id: row.id,
            path: row.path,
            source: row.source === "session" ? "sessions" : "memory",
            startLine: row.start_line,
            endLine: row.end_line,
            text: row.text,
            score: bm25RankToScore(row.rank ?? 999)
          });
        }
      }
    }

    const queryEmbedding = input.queryEmbedding && input.queryEmbedding.length > 0
      ? input.queryEmbedding
      : await this.embedText(query);

    const vectorResults: HybridSearchResult[] = [];
    if (this.vecEnabled && this.vecSearchReady && queryEmbedding.length === this.vecDims) {
      try {
        const sourceFilter = this.buildDbSourceFilter("c.source");
        const rows = searchVectorRows({
          db: this.db,
          queryEmbeddingBlob: vectorToBlob(queryEmbedding),
          workspaceSlug: this.workspaceSlug,
          model: this.embedding.model,
          candidates,
          sourceFilter
        });

        for (const row of rows) {
          vectorResults.push({
            id: row.id,
            path: row.path,
            source: row.source === "session" ? "sessions" : "memory",
            startLine: row.start_line,
            endLine: row.end_line,
            text: row.text,
            score: 1 - row.dist
          });
        }
      } catch {
        this.vecSearchReady = false;
      }
    }

    if (vectorResults.length === 0 && queryEmbedding.length > 0) {
      const sourceFilter = this.buildDbSourceFilter("source");
      const rows = searchDenseFallbackRows({
        db: this.db,
        workspaceSlug: this.workspaceSlug,
        candidates,
        sourceFilter
      });

      for (const row of rows) {
        let embedding: number[] = [];
        try {
          const parsed = JSON.parse(row.embedding ?? "[]") as unknown;
          if (Array.isArray(parsed)) {
            embedding = parsed.filter((item): item is number => typeof item === "number");
          }
        } catch {
          embedding = [];
        }
        if (embedding.length === 0 || embedding.length !== queryEmbedding.length) continue;

        vectorResults.push({
          id: row.id,
          path: row.path,
          source: row.source === "session" ? "sessions" : "memory",
          startLine: row.start_line,
          endLine: row.end_line,
          text: row.text,
          score: cosineSimilarity(queryEmbedding, embedding)
        });
      }

      vectorResults.sort((a, b) => b.score - a.score);
      if (vectorResults.length > candidates) {
        vectorResults.length = candidates;
      }
    }

    const merged = mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: DEFAULT_VECTOR_WEIGHT,
      textWeight: DEFAULT_TEXT_WEIGHT
    });

    const toMemorySearchResult = (item: {
      id: string;
      path?: string;
      startLine?: number;
      endLine?: number;
      text?: string;
      score: number;
      source?: "memory" | "sessions";
    }): MemorySearchResult => ({
      id: item.id,
      path: item.path ?? "",
      startLine: item.startLine ?? 1,
      endLine: item.endLine ?? 1,
      snippet: truncateUtf16Safe(item.text ?? "", SNIPPET_MAX_CHARS),
      citation: formatCitation(item.path ?? "", item.startLine ?? 1, item.endLine ?? 1),
      score: item.score,
      source: item.source ?? "memory"
    });

    let finalResults: MemorySearchResult[] = merged
      .filter((item) => item.score >= minScore)
      .slice(0, maxResults)
      .map(toMemorySearchResult);

    // LIKE 回退：FTS5 和向量都无结果时降级到模糊匹配
    if (finalResults.length === 0 && query.trim()) {
      const words = query.trim().split(/\s+/).slice(0, 5);
      const conditions = words.map((_, i) => `(text LIKE ?${i + 1} OR path LIKE ?${i + 1})`).join(" OR ");
      const sourceFilter = this.buildDbSourceFilter("source");
      const sql = `SELECT id, path, source, start_line, end_line, text FROM chunks
        WHERE workspace_slug = ?${words.length + 1} ${sourceFilter ? `AND ${sourceFilter}` : ""}
        AND (${conditions}) ORDER BY updated_at DESC LIMIT ?${words.length + 2}`;
      try {
        const likeRows = this.db.query(sql).all(
          ...words.map((w) => `%${w}%`),
          this.workspaceSlug,
          maxResults
        ) as Array<{ id: string; path: string; source: string; start_line: number; end_line: number; text: string }>;
        finalResults = likeRows.map((row): MemorySearchResult => ({
          id: row.id,
          path: row.path ?? "",
          startLine: row.start_line ?? 1,
          endLine: row.end_line ?? 1,
          snippet: truncateUtf16Safe(row.text ?? "", SNIPPET_MAX_CHARS),
          citation: formatCitation(row.path ?? "", row.start_line ?? 1, row.end_line ?? 1),
          score: 0.1,
          source: (row.source === "session" ? "sessions" : "memory") as "memory" | "sessions"
        }));
      } catch { /* LIKE 回退失败时返回空 */ }
    }

    return finalResults;
  }

  readFile(input: { path: string; from?: number; lines?: number }): MemoryGetResult {
    let resolvedPath: string;
    if (input.path.startsWith("extra:")) {
      resolvedPath = resolve(input.path.slice("extra:".length));
      ensurePathAllowed({
        workspaceRoot: this.workspaceRoot,
        absPath: resolvedPath,
        extraRoots: this.extraPaths
      });
      if (!isMarkdownFile(resolvedPath)) {
        throw new Error("仅允许读取 Markdown 记忆文件");
      }
      if (existsSync(resolvedPath)) {
        const st = lstatSync(resolvedPath);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new Error("仅允许读取普通 Markdown 记忆文件");
        }
      }
    } else if (input.path.startsWith("sessions/")) {
      if (!this.workspaceId) {
        return { path: input.path, from: input.from ?? 1, lines: input.lines ?? 0, text: "" };
      }
      const session = listThreadEntriesForWorkspace(this.workspaceId).find((item) => item.path === input.path);
      if (!session) {
        return { path: input.path, from: input.from ?? 1, lines: input.lines ?? 0, text: "" };
      }
      const allLines = session.content.split("\n");
      if (input.from === undefined && input.lines === undefined) {
        return { path: input.path, from: 1, lines: allLines.length, text: session.content };
      }
      const from = Math.max(1, input.from ?? 1);
      const lines = Math.max(1, input.lines ?? allLines.length);
      const selected = allLines.slice(from - 1, from - 1 + lines);
      return { path: input.path, from, lines, text: selected.join("\n") };
    } else {
      resolvedPath = ensureInsideRoot(this.workspaceRoot, resolve(this.workspaceRoot, input.path));
      const relPath = relative(this.workspaceRoot, resolvedPath).replace(/\\/g, "/");
      if (!isMemoryPath(relPath)) {
        throw new Error("仅允许读取 MEMORY.md、memory/YYYY-MM-DD.md 或 sessions/*");
      }
      if (existsSync(resolvedPath)) {
        const st = lstatSync(resolvedPath);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new Error("仅允许读取普通 Markdown 记忆文件");
        }
      }
    }
    if (!existsSync(resolvedPath)) {
      return { path: input.path, from: input.from ?? 1, lines: input.lines ?? 0, text: "" };
    }

    const content = readFileSync(resolvedPath, "utf-8");
    const allLines = content.split("\n");
    if (input.from === undefined && input.lines === undefined) {
      return {
        path: input.path,
        from: 1,
        lines: allLines.length,
        text: content
      };
    }
    const from = Math.max(1, input.from ?? 1);
    const lines = Math.max(1, input.lines ?? allLines.length);
    const startIndex = from - 1;
    const selected = allLines.slice(startIndex, startIndex + lines);

    return {
      path: input.path,
      from,
      lines,
      text: selected.join("\n")
    };
  }

  getStats(): MemoryStats {
    return {
      workspaceSlug: this.workspaceSlug,
      fileCount: countFilesForWorkspace({
        db: this.db,
        workspaceSlug: this.workspaceSlug
      }),
      chunkCount: countChunksForWorkspace({
        db: this.db,
        workspaceSlug: this.workspaceSlug
      }),
      ftsEnabled: this.ftsEnabled,
      vecEnabled: this.vecEnabled
    };
  }

  async saveMemory(input: { content: string; date?: string; path?: string }): Promise<MemorySaveResult> {
    const trimmed = input.content.trim();
    if (!trimmed) {
      throw new Error("记忆内容不能为空");
    }

    let relativePath: string;
    let absolutePath: string;

    if (input.path === "MEMORY.md") {
      // 长期记忆：追加到 MEMORY.md
      relativePath = input.path;
      absolutePath = ensureInsideRoot(this.workspaceRoot, resolve(this.workspaceRoot, relativePath));
    } else {
      // 短期记忆：写入 memory/YYYY-MM-DD.md
      const date = input.date?.trim() || new Date().toISOString().slice(0, 10);
      const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
      const memoryDir = resolve(this.workspaceRoot, "memory");
      mkdirSync(memoryDir, { recursive: true });
      relativePath = `memory/${safeDate}.md`;
      absolutePath = ensureInsideRoot(this.workspaceRoot, resolve(this.workspaceRoot, relativePath));
    }

    const stamp = new Date().toISOString();
    const block = `\n## ${stamp}\n${trimmed}\n`;
    appendFileSync(absolutePath, block, "utf-8");

    await this.indexFile(absolutePath, true);
    return {
      path: relativePath,
      bytes: Buffer.byteLength(block, "utf-8")
    };
  }
}
