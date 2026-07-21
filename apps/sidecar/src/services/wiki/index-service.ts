import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WikiLintFinding, WikiPageRecord, WikiPageRef, WikiSearchResult } from "@lume/shared";
import { extractWikiLinks, sha256, WikiMarkdownStore } from "./markdown-store";
import { ensureWikiDirectory, resolveWikiPath } from "./path-security";
import { cjkNgrams } from "./search-text";
import { WikiSourceStore } from "./source-store";
import { createMemoryV2EmbeddingAttempts, type MemoryV2EmbeddingAttempt } from "../memory-v2/embedding";
import { dotProduct, toFloat32Array } from "../memory-v2/vector-math";

const require = createRequire(import.meta.url);
const SEMANTIC_SEARCH_TIMEOUT_MS = 1_500;

export class WikiIndexService {
  private db?: DatabaseSync;
  private readonly sources: WikiSourceStore;
  private tokenizer: "trigram" | "unicode61" = "unicode61";
  private mode: "lexical-only" | "hybrid" = "lexical-only";
  constructor(
    readonly root: string,
    readonly store = new WikiMarkdownStore(root),
    private readonly embeddingAttempts: () => MemoryV2EmbeddingAttempt[] = () => createMemoryV2EmbeddingAttempts(undefined, { includeImplicitLocal: true }),
  ) {
    this.sources = new WikiSourceStore(root);
  }

  searchMode(): "lexical-only" | "hybrid" { return this.mode; }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    ensureWikiDirectory(this.root, ".lume/index");
    const { DatabaseSync: RuntimeDatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    this.db = new RuntimeDatabaseSync(resolveWikiPath(this.root, ".lume/index/wiki.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    return this.db;
  }

  rebuild(): number {
    const db = this.open();
    db.exec(`
      DROP TABLE IF EXISTS pages_fts; DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS sections;
      DROP TABLE IF EXISTS source_blobs; DROP TABLE IF EXISTS provenance_records; DROP TABLE IF EXISTS tags;
      DROP TABLE IF EXISTS workspace_associations; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS aliases;
      DROP TABLE IF EXISTS source_citations; DROP TABLE IF EXISTS revisions; DROP TABLE IF EXISTS lint_findings;
      DROP TABLE IF EXISTS cjk_grams; DROP TABLE IF EXISTS metadata;
      CREATE TABLE pages(id TEXT PRIMARY KEY, file_key TEXT UNIQUE NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE sections(page_id TEXT NOT NULL, heading TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE source_blobs(hash TEXT PRIMARY KEY, byte_size INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE provenance_records(id TEXT PRIMARY KEY, blob_hash TEXT, lifecycle_state TEXT NOT NULL);
      CREATE TABLE tags(page_id TEXT NOT NULL, tag TEXT NOT NULL);
      CREATE TABLE workspace_associations(page_id TEXT NOT NULL, workspace_id TEXT, relation TEXT NOT NULL);
      CREATE TABLE links(source_page_id TEXT NOT NULL, target_file_key TEXT NOT NULL);
      CREATE TABLE aliases(page_id TEXT NOT NULL, alias TEXT NOT NULL);
      CREATE TABLE source_citations(page_id TEXT NOT NULL, source_id TEXT NOT NULL);
      CREATE TABLE revisions(page_id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE lint_findings(id TEXT PRIMARY KEY, page_id TEXT, rule TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE cjk_grams(page_id TEXT NOT NULL, gram TEXT NOT NULL, PRIMARY KEY(page_id, gram));
      CREATE TABLE IF NOT EXISTS embedding_cache(model_key TEXT NOT NULL, block_content_hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(model_key, block_content_hash));
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX cjk_grams_gram ON cjk_grams(gram); CREATE INDEX associations_workspace ON workspace_associations(workspace_id, page_id);
    `);
    try {
      db.exec("CREATE VIRTUAL TABLE pages_fts USING fts5(page_id UNINDEXED, content, tokenize='trigram')");
      this.tokenizer = "trigram";
    } catch {
      db.exec("CREATE VIRTUAL TABLE pages_fts USING fts5(page_id UNINDEXED, content, tokenize='unicode61')");
      this.tokenizer = "unicode61";
    }
    const pages = this.store.listPages();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const page of pages) this.insertPage(db, page);
      for (const source of this.sources.listManifests()) {
        db.prepare("INSERT INTO provenance_records VALUES(?,?,?)").run(source.id, source.blob_hash ?? null, this.sources.lifecycleState(source.id));
        if (source.blob_hash) db.prepare("INSERT OR IGNORE INTO source_blobs VALUES(?,?)").run(source.blob_hash, source.byte_size);
      }
      const generation = Date.now();
      db.prepare("INSERT INTO metadata(key,value) VALUES('generation',?)").run(String(generation));
      db.prepare("INSERT INTO metadata(key,value) VALUES('tokenizer',?)").run(this.tokenizer);
      db.prepare("INSERT INTO metadata(key,value) VALUES('fingerprint',?)").run(pageFingerprint(pages));
      db.exec("COMMIT");
      return generation;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureFresh(): number {
    try {
      const db = this.open();
      const row = db.prepare("SELECT value FROM metadata WHERE key='generation'").get() as { value?: string } | undefined;
      const fingerprint = db.prepare("SELECT value FROM metadata WHERE key='fingerprint'").get() as { value?: string } | undefined;
      if (!row?.value || fingerprint?.value !== pageFingerprint(this.store.listPages())) return this.rebuild();
      return Number(row.value);
    } catch {
      this.db?.close();
      this.db = undefined;
      const path = resolveWikiPath(this.root, ".lume/index/wiki.sqlite");
      if (existsSync(path)) rmSync(path, { force: true });
      return this.rebuild();
    }
  }

  async search(query: string, visiblePages: WikiPageRecord[], maxResults = 20): Promise<WikiSearchResult[]> {
    const lexical = this.searchLexical(query, visiblePages, Math.max(maxResults, 50));
    if (!query.trim() || visiblePages.length === 0) return lexical.slice(0, maxResults);
    for (const attempt of this.embeddingAttempts()) {
      try {
        const semantic = await withTimeout(
          this.semanticScores(query, visiblePages, attempt),
          SEMANTIC_SEARCH_TIMEOUT_MS,
        );
        this.mode = "hybrid";
        return fuseResults(lexical, semantic, visiblePages, maxResults);
      } catch {
        // Semantic initialization can be slow on first use; lexical search stays available.
      }
    }
    this.mode = "lexical-only";
    return lexical.slice(0, maxResults);
  }

  replaceLintFindings(findings: WikiLintFinding[]): void {
    this.ensureFresh();
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM lint_findings");
      const insert = db.prepare("INSERT INTO lint_findings VALUES(?,?,?,?,?)");
      for (const finding of findings) insert.run(finding.id, finding.pageId ?? null, finding.rule, finding.severity, finding.message);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  searchLexical(query: string, visiblePages: WikiPageRecord[], maxResults = 20): WikiSearchResult[] {
    if (!query.trim() || visiblePages.length === 0) return [];
    this.ensureFresh();
    const db = this.open();
    const allowed = new Set(visiblePages.map((page) => page.id));
    const scores = new Map<string, { score: number; matchedBy: WikiSearchResult["matchedBy"] }>();
    const grams = cjkNgrams(query);
    if (grams.length > 0) {
      const placeholders = grams.map(() => "?").join(",");
      const rows = db.prepare(`SELECT page_id, COUNT(*) hits FROM cjk_grams WHERE gram IN (${placeholders}) GROUP BY page_id ORDER BY hits DESC LIMIT 200`).all(...grams) as Array<{ page_id: string; hits: number }>;
      for (const row of rows) if (allowed.has(row.page_id)) scores.set(row.page_id, { score: row.hits / grams.length, matchedBy: ["lexical"] });
    }
    const tokens = query.trim().replace(/["']/g, " ").split(/\s+/).filter(Boolean).map((token) => `"${token}"`).join(" OR ");
    if (tokens) {
      try {
        const rows = db.prepare("SELECT page_id, bm25(pages_fts) rank FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT 200").all(tokens) as Array<{ page_id: string; rank: number }>;
        for (const row of rows) if (allowed.has(row.page_id)) {
          const current = scores.get(row.page_id) ?? { score: 0, matchedBy: [] };
          current.score += 1 / (1 + Math.abs(row.rank));
          if (!current.matchedBy.includes("lexical")) current.matchedBy.push("lexical");
          scores.set(row.page_id, current);
        }
      } catch { /* CJK auxiliary table still provides bounded recall. */ }
    }
    const lower = query.toLocaleLowerCase();
    for (const page of visiblePages) {
      const title = page.title.toLocaleLowerCase();
      const alias = page.frontmatter.aliases.some((item) => item.toLocaleLowerCase().includes(lower));
      if (title.includes(lower) || alias) {
        const current = scores.get(page.id) ?? { score: 0, matchedBy: [] };
        current.score += title === lower ? 4 : title.includes(lower) ? 3 : 2;
        current.matchedBy.push(title.includes(lower) ? "title" : "alias");
        scores.set(page.id, current);
      }
    }
    return [...scores.entries()].map(([id, value]) => {
      const page = visiblePages.find((item) => item.id === id)!;
      return { page: toWikiSearchPageRef(page), snippet: page.body.replace(/\s+/g, " ").slice(0, 240), score: value.score, matchedBy: [...new Set(value.matchedBy)] };
    }).sort((left, right) => right.score - left.score || left.page.id.localeCompare(right.page.id)).slice(0, maxResults);
  }

  private async semanticScores(query: string, pages: WikiPageRecord[], attempt: MemoryV2EmbeddingAttempt): Promise<Map<string, number>> {
    const vectors = await this.pageVectors(pages, attempt);
    const [queryVector] = await attempt.embedTexts([query]);
    if (!queryVector?.length) throw new Error("Wiki query embedding is unavailable");
    const needle = toFloat32Array(queryVector);
    return new Map(pages.map((page) => [page.id, dotProduct(needle, vectors.get(page.id) ?? new Float32Array())]));
  }

  async runSemanticHealth(pages: WikiPageRecord[], generation: number): Promise<{ modelKey: string; findings: WikiLintFinding[] }> {
    let lastError: unknown;
    for (const attempt of this.embeddingAttempts()) {
      try {
        if (pages.length === 0) {
          const probe = await attempt.embedTexts(["Wiki semantic health probe"]);
          if (!probe[0]?.length) throw new Error("Wiki semantic model probe failed");
        }
        const vectors = await this.pageVectors(pages, attempt);
        const findings: WikiLintFinding[] = [];
        const candidateGroups = new Map<string, WikiPageRecord[]>();
        for (const page of pages) {
          const key = `${page.type}:${page.title.toLocaleLowerCase().replace(/\s+/g, "").slice(0, 4)}`;
          candidateGroups.set(key, [...(candidateGroups.get(key) ?? []), page]);
          if ((page.type === "source" || page.type === "synthesis") && extractWikiLinks(page.body).length === 0) {
            findings.push(semanticFinding("knowledge-gap", "info", "该页面没有链接到长期主题页，可考虑补充关联。", page.id, generation));
          }
          if (page.type === "decision" && Date.now() - Date.parse(page.frontmatter.updated) > 180 * 24 * 60 * 60 * 1_000) {
            findings.push(semanticFinding("stale-decision", "info", "该决策超过 180 天未复核。", page.id, generation));
          }
        }
        for (const group of candidateGroups.values()) {
          for (let left = 0; left < group.length; left += 1) for (let right = left + 1; right < Math.min(group.length, left + 51); right += 1) {
            const a = group[left]!; const b = group[right]!;
            if (dotProduct(vectors.get(a.id)!, vectors.get(b.id)!) >= 0.94) findings.push(semanticFinding("near-duplicate", "warning", `疑似与「${b.title}」重复，请人工判断是否合并。`, a.id, generation));
          }
        }
        return { modelKey: attempt.modelKey, findings: findings.slice(0, 500) };
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error("Wiki semantic model unavailable");
  }

  private async pageVectors(pages: WikiPageRecord[], attempt: MemoryV2EmbeddingAttempt): Promise<Map<string, Float32Array>> {
    this.ensureFresh();
    const db = this.open();
    const vectors = new Map<string, Float32Array>();
    const missing: WikiPageRecord[] = [];
    for (const page of pages) {
      const row = db.prepare("SELECT vector FROM embedding_cache WHERE model_key=? AND block_content_hash=?").get(attempt.modelKey, page.hash) as { vector?: Uint8Array } | undefined;
      if (row?.vector) vectors.set(page.id, decodeVector(row.vector)); else missing.push(page);
    }
    if (missing.length > 0) {
      const embedded = await attempt.embedTexts(missing.map((page) => `${page.title}\n${page.frontmatter.aliases.join(" ")}\n${page.body}`));
      if (embedded.length !== missing.length) throw new Error("Wiki embedding response shape is invalid");
      for (let index = 0; index < missing.length; index += 1) {
        const page = missing[index]!; const vector = toFloat32Array(embedded[index]!);
        vectors.set(page.id, vector);
        db.prepare("INSERT OR REPLACE INTO embedding_cache(model_key,block_content_hash,vector) VALUES(?,?,?)").run(attempt.modelKey, page.hash, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
      }
    }
    return vectors;
  }

  private insertPage(db: DatabaseSync, page: WikiPageRecord): void {
    db.prepare("INSERT INTO pages VALUES(?,?,?,?,?,?,?,?)").run(page.id, page.fileKey, page.title, page.type, page.status, page.body, page.hash, page.revision);
    db.prepare("INSERT INTO pages_fts(page_id,content) VALUES(?,?)").run(page.id, `${page.title}\n${page.frontmatter.aliases.join(" ")}\n${page.body}`);
    for (const gram of cjkNgrams(`${page.title}${page.frontmatter.aliases.join("")}${page.body}`)) db.prepare("INSERT OR IGNORE INTO cjk_grams VALUES(?,?)").run(page.id, gram);
    for (const tag of page.frontmatter.tags) db.prepare("INSERT INTO tags VALUES(?,?)").run(page.id, tag);
    for (const alias of page.frontmatter.aliases) db.prepare("INSERT INTO aliases VALUES(?,?)").run(page.id, alias);
    if (page.primaryWorkspaceId) db.prepare("INSERT INTO workspace_associations VALUES(?,?,?)").run(page.id, page.primaryWorkspaceId, "primary");
    for (const id of page.associatedWorkspaceIds) db.prepare("INSERT INTO workspace_associations VALUES(?,?,?)").run(page.id, id, "associated");
    for (const link of extractWikiLinks(page.body)) db.prepare("INSERT INTO links VALUES(?,?)").run(page.id, link);
    for (const sourceId of page.frontmatter.source_ids) db.prepare("INSERT INTO source_citations VALUES(?,?)").run(page.id, sourceId);
    db.prepare("INSERT INTO revisions VALUES(?,?,?)").run(page.id, page.revision, page.hash);
    for (const section of page.body.split(/^# /m).filter(Boolean)) {
      const [heading = "", ...content] = section.split("\n");
      db.prepare("INSERT INTO sections VALUES(?,?,?,?)").run(page.id, heading.trim(), content.join("\n").trim(), sha256(section));
    }
  }
}

function decodeVector(value: Uint8Array): Float32Array {
  const copy = Uint8Array.from(value);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / Float32Array.BYTES_PER_ELEMENT));
}

function fuseResults(
  lexical: WikiSearchResult[],
  semantic: Map<string, number>,
  pages: WikiPageRecord[],
  maxResults: number,
): WikiSearchResult[] {
  const lexicalById = new Map(lexical.map((item, index) => [item.page.id, { item, rank: index + 1 }]));
  const semanticRank = [...semantic.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const semanticById = new Map(semanticRank.map(([id, score], index) => [id, { score, rank: index + 1 }]));
  // A lexical hit is a hard filter for the UI search. Otherwise every visible
  // page would be returned after semantic scoring, making an exact search look ineffective.
  const candidates = lexical.length > 0 ? pages.filter((page) => lexicalById.has(page.id)) : pages;
  return candidates.map((page) => {
    const lexicalMatch = lexicalById.get(page.id);
    const semanticMatch = semanticById.get(page.id);
    const score = (lexicalMatch ? 1 / (60 + lexicalMatch.rank) : 0) + (semanticMatch ? 1 / (60 + semanticMatch.rank) : 0);
    return {
      page: toWikiSearchPageRef(page),
      snippet: lexicalMatch?.item.snippet ?? page.body.replace(/\s+/g, " ").slice(0, 240),
      score,
      matchedBy: [...new Set([...(lexicalMatch?.item.matchedBy ?? []), ...(semanticMatch ? ["semantic" as const] : [])])],
    };
  }).sort((left, right) => right.score - left.score || left.page.id.localeCompare(right.page.id)).slice(0, maxResults);
}

export function toWikiSearchPageRef(page: WikiPageRecord): WikiPageRef {
  return {
    id: page.id,
    fileKey: page.fileKey,
    title: page.title,
    type: page.type,
    status: page.status,
    primaryWorkspaceId: page.primaryWorkspaceId,
    associatedWorkspaceIds: page.associatedWorkspaceIds,
    ...(page.path ? { path: page.path } : {}),
  };
}

function pageFingerprint(pages: WikiPageRecord[]): string {
  return sha256(pages.map((page) => `${page.id}:${page.hash}`).sort().join("\n"));
}

function semanticFinding(rule: string, severity: WikiLintFinding["severity"], message: string, pageId: string, generation: number): WikiLintFinding {
  return { id: randomUUID(), rule, severity, message, pageId, createdAt: new Date().toISOString(), generation };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Wiki semantic search timed out")), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
