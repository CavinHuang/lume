import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WikiPageRecord, WikiSearchResult } from "@lume/shared";
import { extractWikiLinks, sha256, WikiMarkdownStore } from "./markdown-store";
import { ensureWikiDirectory, resolveWikiPath } from "./path-security";
import { cjkNgrams } from "./search-text";

export class WikiIndexService {
  private db?: DatabaseSync;
  private tokenizer: "trigram" | "unicode61" = "unicode61";
  constructor(readonly root: string, readonly store = new WikiMarkdownStore(root)) {}

  private open(): DatabaseSync {
    if (this.db) return this.db;
    ensureWikiDirectory(this.root, ".lume/index");
    this.db = new DatabaseSync(resolveWikiPath(this.root, ".lume/index/wiki.sqlite"));
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
      DROP TABLE IF EXISTS cjk_grams; DROP TABLE IF EXISTS embedding_cache; DROP TABLE IF EXISTS metadata;
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
      CREATE TABLE embedding_cache(model_key TEXT NOT NULL, block_content_hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(model_key, block_content_hash));
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

  search(query: string, visiblePages: WikiPageRecord[], maxResults = 20): WikiSearchResult[] {
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
      return { page, snippet: page.body.replace(/\s+/g, " ").slice(0, 240), score: value.score, matchedBy: [...new Set(value.matchedBy)] };
    }).sort((left, right) => right.score - left.score || left.page.id.localeCompare(right.page.id)).slice(0, maxResults);
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

function pageFingerprint(pages: WikiPageRecord[]): string {
  return sha256(pages.map((page) => `${page.id}:${page.hash}`).sort().join("\n"));
}
