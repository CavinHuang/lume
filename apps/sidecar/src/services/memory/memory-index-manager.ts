import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { Database } from "bun:sqlite";
import {
  DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_INDEX_CONCURRENCY,
  SNIPPET_MAX_CHARS,
  DEFAULT_TEXT_WEIGHT,
  DEFAULT_VECTOR_WEIGHT
} from "./constants";
import { chunkMarkdown } from "./memory-chunker";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid-search";
import { createLiteEmbedding } from "./embeddings-lite";
import { embedTextWithProvider, embedTextsWithProvider, resolveEmbeddingProvider, type ResolvedEmbeddingProvider } from "./embedding-provider";
import type { HybridSearchResult } from "./types";
import { listSessionEntriesForWorkspace } from "./session-files";
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

interface ChunkSearchRow {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  rank?: number;
  embedding?: string;
}

const SQLITE_VEC_DIMS = 1536;

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

function ensureInsideRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || rel.startsWith("../") || rel === "..") {
    throw new Error("目标路径超出工作区允许范围");
  }
  return resolvedTarget;
}

function normalizeExtraMemoryPaths(workspaceRoot: string, extraPaths: string[]): string[] {
  const resolved = extraPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(workspaceRoot, value));
  return Array.from(new Set(resolved));
}

function ensurePathAllowed(params: {
  workspaceRoot: string;
  absPath: string;
  extraRoots: string[];
}): void {
  const resolvedTarget = resolve(params.absPath);
  const resolvedWorkspace = resolve(params.workspaceRoot);
  const relWorkspace = relative(resolvedWorkspace, resolvedTarget);
  if (!relWorkspace.startsWith("..") && relWorkspace !== "..") return;

  for (const extraRoot of params.extraRoots) {
    const rel = relative(extraRoot, resolvedTarget);
    if (!rel.startsWith("..") && rel !== "..") {
      return;
    }
  }

  throw new Error("目标路径超出允许范围");
}

function isMarkdownFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

function collectMarkdownFiles(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  const entries = readdirSync(baseDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(baseDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && isMarkdownFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

export class MemoryIndexManager {
  private readonly db: Database;
  private readonly workspaceRoot: string;
  private readonly workspaceSlug: string;
  private readonly ftsEnabled: boolean;
  private vecEnabled: boolean;
  private vecSearchReady: boolean;
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
    this.workspaceId = params.workspaceId;
    this.sources = new Set((params.sources ?? ["memory"]).filter((item) => item === "memory" || item === "sessions"));
    if (this.sources.size === 0) this.sources.add("memory");
    this.extraPaths = normalizeExtraMemoryPaths(this.workspaceRoot, params.extraPaths ?? []);
    this.db = new Database(params.dbPath, { create: true, strict: true });
    this.embedding = resolveEmbeddingProvider();

    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");

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
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[1536]
        );
      `);
      // 某些环境会在 CREATE 阶段不报错，但首次访问时报 “no such table/module”。
      this.db.query("SELECT id FROM chunks_vec LIMIT 0").all();
    } catch {
      vecEnabled = false;
    }
    this.vecEnabled = vecEnabled;
    this.vecSearchReady = vecEnabled;
  }

  dispose(): void {
    this.db.close();
  }

  status(): {
    provider: string;
    model: string;
    fallback?: { from?: string; reason?: string };
    ftsEnabled: boolean;
    vecEnabled: boolean;
  } {
    return {
      provider: this.embedding.provider,
      model: this.embedding.model,
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
  }, force: boolean): Promise<number> {
    const hash = sha256(entry.content);
    const existing = this.getFileMeta(entry.logicalPath);
    if (!force && existing && existing.hash === hash && existing.mtime === entry.mtimeMs && existing.size === entry.size) {
      return 0;
    }

    const chunks = chunkMarkdown(entry.content, entry.logicalPath, { model: this.embedding.model });
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

        if (this.vecEnabled && embedding.length === SQLITE_VEC_DIMS) {
          try {
            this.db.query(
              `INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?1, ?2)`
            ).run(chunk.id, vectorToBlob(embedding));
          } catch {
            // vec0 写入失败不阻塞主流程
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

  private getCachedEmbedding(text: string): number[] | null {
    const hash = sha256(text);
    const row = this.db
      .query(
        `SELECT embedding FROM embedding_cache
         WHERE provider = ?1 AND model = ?2 AND provider_key = ?3 AND hash = ?4`
      )
      .get(this.embedding.provider, this.embedding.model, this.embedding.providerKey, hash) as { embedding?: string } | null;

    if (!row?.embedding) return null;
    try {
      const parsed = JSON.parse(row.embedding) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is number => typeof item === "number");
      }
    } catch {
      return null;
    }
    return null;
  }

  private setCachedEmbedding(text: string, embedding: number[]): void {
    const hash = sha256(text);
    this.db
      .query(
        `INSERT OR REPLACE INTO embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .run(
        this.embedding.provider,
        this.embedding.model,
        this.embedding.providerKey,
        hash,
        JSON.stringify(embedding),
        embedding.length,
        Date.now()
      );
  }

  private async embedText(text: string): Promise<number[]> {
    const cached = this.getCachedEmbedding(text);
    if (cached && cached.length > 0) {
      return cached;
    }

    let embedding: number[];
    try {
      embedding = await embedTextWithProvider(text, this.embedding);
    } catch (error) {
      console.warn("[记忆索引] 远程 embedding 失败，回退 Lite:", error);
      embedding = createLiteEmbedding(text);
    }

    this.setCachedEmbedding(text, embedding);
    return embedding;
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const result = Array.from({ length: texts.length }, () => [] as number[]);
    const misses: Array<{ index: number; text: string }> = [];

    texts.forEach((text, index) => {
      const cached = this.getCachedEmbedding(text);
      if (cached && cached.length > 0) {
        result[index] = cached;
      } else {
        misses.push({ index, text });
      }
    });

    if (misses.length > 0) {
      let missEmbeddings: number[][];
      try {
        missEmbeddings = await embedTextsWithProvider(
          misses.map((item) => item.text),
          this.embedding,
          {
            concurrency: EMBEDDING_INDEX_CONCURRENCY,
            batchSize: EMBEDDING_BATCH_SIZE
          }
        );
      } catch (error) {
        console.warn("[记忆索引] batch embedding 失败，回退 Lite:", error);
        missEmbeddings = misses.map((item) => createLiteEmbedding(item.text));
      }

      misses.forEach((item, missIndex) => {
        const embedding = missEmbeddings[missIndex] ?? createLiteEmbedding(item.text);
        result[item.index] = embedding;
        this.setCachedEmbedding(item.text, embedding);
      });
    }

    return result;
  }

  async indexFile(filePath: string, force = false): Promise<number> {
    const resolvedPath = ensureInsideRoot(this.workspaceRoot, resolve(this.workspaceRoot, filePath));
    const relativePath = relative(this.workspaceRoot, resolvedPath).replace(/\\/g, "/");

    if (!existsSync(resolvedPath) || !isMarkdownFile(resolvedPath)) {
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
    const targetEntries: Array<{
      source: "memory" | "session";
      logicalPath: string;
      absPath: string;
      content: string;
      mtimeMs: number;
      size: number;
    }> = [];

    if (this.sources.has("memory")) {
      const memoryFiles = new Set<string>();
      const longTerm = resolve(this.workspaceRoot, "MEMORY.md");
      if (existsSync(longTerm)) memoryFiles.add(longTerm);
      const memoryDir = resolve(this.workspaceRoot, "memory");
      for (const file of collectMarkdownFiles(memoryDir)) {
        memoryFiles.add(file);
      }
      for (const extraPath of this.extraPaths) {
        if (!existsSync(extraPath)) continue;
        const st = statSync(extraPath);
        if (st.isDirectory()) {
          for (const file of collectMarkdownFiles(extraPath)) {
            memoryFiles.add(file);
          }
          continue;
        }
        if (st.isFile() && isMarkdownFile(extraPath)) {
          memoryFiles.add(extraPath);
        }
      }

      for (const absPath of memoryFiles) {
        const stat = statSync(absPath);
        const content = readFileSync(absPath, "utf-8");
        let logicalPath = relative(this.workspaceRoot, absPath).replace(/\\/g, "/");
        if (logicalPath.startsWith("..")) {
          logicalPath = `extra:${resolve(absPath).replace(/\\/g, "/")}`;
        }
        targetEntries.push({
          source: "memory",
          logicalPath,
          absPath: resolve(absPath),
          content,
          mtimeMs: stat.mtimeMs,
          size: stat.size
        });
      }
    }

    if (this.sources.has("sessions") && this.workspaceId) {
      for (const entry of listSessionEntriesForWorkspace(this.workspaceId)) {
        targetEntries.push({
          source: "session",
          logicalPath: entry.path,
          absPath: entry.absPath,
          content: entry.content,
          mtimeMs: entry.mtimeMs,
          size: entry.size
        });
      }
    }

    let total = 0;
    for (const entry of targetEntries) {
      total += await this.indexContentEntry(entry, force);
    }

    const targetSet = new Set(targetEntries.map((item) => item.logicalPath));
    const indexedRows = this.db
      .query(
        `SELECT path, source FROM files
         WHERE workspace_slug = ?1`
      )
      .all(this.workspaceSlug) as Array<{ path: string; source: string }>;
    for (const row of indexedRows) {
      if (!targetSet.has(row.path) && (row.source === "memory" || row.source === "session")) {
        this.removeFileChunks(row.path);
        this.db.query("DELETE FROM files WHERE path = ?1").run(row.path);
      }
    }

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
        const rows = this.db
          .query(
            `SELECT id, path, start_line, end_line, text, bm25(chunks_fts) AS rank
             FROM chunks_fts
             WHERE chunks_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2`
          )
          .all(ftsQuery, candidates) as ChunkSearchRow[];

        for (const row of rows) {
          keywordResults.push({
            id: row.id,
            path: row.path,
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
    if (this.vecEnabled && this.vecSearchReady && queryEmbedding.length === SQLITE_VEC_DIMS) {
      try {
        const rows = this.db
          .query(
            `SELECT c.id, c.path, c.start_line, c.end_line, c.text,
                    vec_distance_cosine(v.embedding, ?1) AS dist
             FROM chunks_vec v
             JOIN chunks c ON c.id = v.id
             WHERE c.workspace_slug = ?2 AND c.model = ?3
             ORDER BY dist ASC
             LIMIT ?4`
          )
          .all(
            vectorToBlob(queryEmbedding),
            this.workspaceSlug,
            this.embedding.model,
            candidates
          ) as Array<{
            id: string;
            path: string;
            start_line: number;
            end_line: number;
            text: string;
            dist: number;
          }>;

        for (const row of rows) {
          vectorResults.push({
            id: row.id,
            path: row.path,
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
      const rows = this.db
        .query(
          `SELECT id, path, start_line, end_line, text, embedding
           FROM chunks
           WHERE workspace_slug = ?1
           LIMIT ?2`
        )
        .all(this.workspaceSlug, candidates * 4) as ChunkSearchRow[];

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

    return merged
      .filter((item) => item.score >= minScore)
      .slice(0, maxResults)
      .map((item) => ({
        id: item.id,
        path: item.path ?? "",
        startLine: item.startLine ?? 1,
        endLine: item.endLine ?? 1,
        snippet: truncateUtf16Safe(item.text ?? "", SNIPPET_MAX_CHARS),
        citation: formatCitation(item.path ?? "", item.startLine ?? 1, item.endLine ?? 1),
        score: item.score,
        source: item.source
      }));
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
    } else if (input.path.startsWith("sessions/")) {
      if (!this.workspaceId) {
        return { path: input.path, from: input.from ?? 1, lines: input.lines ?? 0, text: "" };
      }
      const session = listSessionEntriesForWorkspace(this.workspaceId).find((item) => item.path === input.path);
      if (!session) {
        return { path: input.path, from: input.from ?? 1, lines: input.lines ?? 0, text: "" };
      }
      const allLines = session.content.split("\n");
      const from = Math.max(1, input.from ?? 1);
      const lines = Math.max(1, input.lines ?? 200);
      const selected = allLines.slice(from - 1, from - 1 + lines);
      return { path: input.path, from, lines, text: selected.join("\n") };
    } else {
      resolvedPath = ensureInsideRoot(this.workspaceRoot, resolve(this.workspaceRoot, input.path));
    }
    if (!existsSync(resolvedPath)) {
      return { path: input.path, from: input.from ?? 1, lines: input.lines ?? 0, text: "" };
    }

    const content = readFileSync(resolvedPath, "utf-8");
    const allLines = content.split("\n");
    const from = Math.max(1, input.from ?? 1);
    const lines = Math.max(1, input.lines ?? 200);
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
    const fileRow = this.db.query("SELECT COUNT(*) AS count FROM files WHERE workspace_slug = ?1").get(this.workspaceSlug) as { count?: number } | null;
    const chunkRow = this.db.query("SELECT COUNT(*) AS count FROM chunks WHERE workspace_slug = ?1").get(this.workspaceSlug) as { count?: number } | null;

    return {
      workspaceSlug: this.workspaceSlug,
      fileCount: fileRow?.count ?? 0,
      chunkCount: chunkRow?.count ?? 0,
      ftsEnabled: this.ftsEnabled,
      vecEnabled: this.vecEnabled
    };
  }

  async saveMemory(input: { content: string; date?: string }): Promise<MemorySaveResult> {
    const trimmed = input.content.trim();
    if (!trimmed) {
      throw new Error("记忆内容不能为空");
    }

    const date = input.date?.trim() || new Date().toISOString().slice(0, 10);
    const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    const memoryDir = resolve(this.workspaceRoot, "memory");
    mkdirSync(memoryDir, { recursive: true });

    const relativePath = `memory/${safeDate}.md`;
    const absolutePath = ensureInsideRoot(this.workspaceRoot, resolve(this.workspaceRoot, relativePath));
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
