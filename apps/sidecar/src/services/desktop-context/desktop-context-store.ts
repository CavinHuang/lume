import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { DesktopContextSnapshot } from "@lume/shared";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SECRET_RE = /((?:password|passwd|token|api[_-]?key|secret|otp|验证码|校验码)\s*[:=]?\s*)([^\s,，;；]+)/gi;

interface ContextRow {
  id: string;
  encrypted_payload: Uint8Array;
}

interface SearchRow {
  redacted_payload: string;
}

export class DesktopContextStore {
  readonly #db: NodeDatabaseSync;
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #maxBytes: number;

  constructor(input: {
    dbPath: string;
    key: Buffer;
    now?: () => number;
    retentionMs?: number;
    maxBytes?: number;
  }) {
    if (input.key.length !== 32) throw new Error("desktop context key must be 32 bytes");
    mkdirSync(dirname(input.dbPath), { recursive: true });
    this.#key = Buffer.from(input.key);
    this.#now = input.now ?? Date.now;
    this.#retentionMs = input.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    this.#db = new DatabaseSync(input.dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS desktop_context (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        redacted_payload TEXT NOT NULL,
        encrypted_payload BLOB NOT NULL,
        byte_size INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS desktop_context_fts USING fts5(
        id UNINDEXED,
        search_text
      );
      CREATE INDEX IF NOT EXISTS desktop_context_captured_at
        ON desktop_context(captured_at);
    `);
  }

  put(snapshot: DesktopContextSnapshot): void {
    const redacted = redactSnapshot(snapshot);
    const encrypted = encryptPayload(this.#key, Buffer.from(JSON.stringify(snapshot), "utf8"));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM desktop_context_fts WHERE id = ?").run(snapshot.id);
      this.#db.prepare(`
        INSERT OR REPLACE INTO desktop_context
          (id, app_id, window_id, captured_at, redacted_payload, encrypted_payload, byte_size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.id,
        snapshot.app.id,
        snapshot.window.id,
        snapshot.capturedAt,
        JSON.stringify(redacted),
        encrypted,
        encrypted.byteLength,
      );
      this.#db.prepare("INSERT INTO desktop_context_fts (id, search_text) VALUES (?, ?)")
        .run(snapshot.id, contextSearchText(redacted));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): DesktopContextSnapshot | undefined {
    const row = this.#db.prepare("SELECT id, encrypted_payload FROM desktop_context WHERE id = ?")
      .get(id) as unknown as ContextRow | undefined;
    if (!row) return undefined;
    const plain = decryptPayload(this.#key, Buffer.from(row.encrypted_payload));
    return JSON.parse(plain.toString("utf8")) as DesktopContextSnapshot;
  }

  getRedacted(id: string): DesktopContextSnapshot | undefined {
    const row = this.#db.prepare("SELECT redacted_payload FROM desktop_context WHERE id = ?")
      .get(id) as unknown as SearchRow | undefined;
    return row ? JSON.parse(row.redacted_payload) as DesktopContextSnapshot : undefined;
  }

  latest(): DesktopContextSnapshot | undefined {
    const row = this.#db.prepare("SELECT id FROM desktop_context ORDER BY captured_at DESC LIMIT 1")
      .get() as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
  }

  latestRedacted(): DesktopContextSnapshot | undefined {
    const row = this.#db.prepare("SELECT redacted_payload FROM desktop_context ORDER BY captured_at DESC LIMIT 1")
      .get() as unknown as SearchRow | undefined;
    return row ? JSON.parse(row.redacted_payload) as DesktopContextSnapshot : undefined;
  }

  recent(limit = 50): DesktopContextSnapshot[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.#db.prepare(
      "SELECT redacted_payload FROM desktop_context ORDER BY captured_at DESC LIMIT ?",
    ).all(boundedLimit) as unknown as SearchRow[];
    return rows.map((row) => JSON.parse(row.redacted_payload) as DesktopContextSnapshot);
  }

  search(query: string, limit = 20): DesktopContextSnapshot[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = /[\u3400-\u9fff]/u.test(trimmed)
      ? this.#db.prepare(`
          SELECT redacted_payload
          FROM desktop_context
          WHERE redacted_payload LIKE ?
          ORDER BY captured_at DESC
          LIMIT ?
        `).all(`%${escapeLike(trimmed)}%`, boundedLimit) as unknown as SearchRow[]
      : this.#db.prepare(`
          SELECT c.redacted_payload
          FROM desktop_context_fts f
          JOIN desktop_context c ON c.id = f.id
          WHERE desktop_context_fts MATCH ?
          ORDER BY c.captured_at DESC
          LIMIT ?
        `).all(toFtsQuery(trimmed), boundedLimit) as unknown as SearchRow[];
    return rows.map((row) => JSON.parse(row.redacted_payload) as DesktopContextSnapshot);
  }

  purge(): void {
    const expiresBefore = this.#now() - this.#retentionMs;
    const expired = this.#db.prepare("SELECT id FROM desktop_context WHERE captured_at < ?")
      .all(expiresBefore) as unknown as Array<{ id: string }>;
    this.#deleteIds(expired.map((row) => row.id));

    const totals = this.#db.prepare("SELECT COALESCE(SUM(byte_size), 0) AS bytes, COUNT(*) AS count FROM desktop_context")
      .get() as { bytes: number; count: number };
    let bytes = Number(totals.bytes);
    let count = Number(totals.count);
    while (bytes > this.#maxBytes && count > 1) {
      const oldest = this.#db.prepare("SELECT id, byte_size FROM desktop_context ORDER BY captured_at ASC LIMIT 1")
        .get() as { id: string; byte_size: number } | undefined;
      if (!oldest) break;
      this.#deleteIds([oldest.id]);
      bytes -= Number(oldest.byte_size);
      count -= 1;
    }
  }

  stats(): { items: number; bytes: number } {
    const row = this.#db.prepare(
      "SELECT COUNT(*) AS items, COALESCE(SUM(byte_size), 0) AS bytes FROM desktop_context",
    ).get() as { items: number; bytes: number };
    return { items: Number(row.items), bytes: Number(row.bytes) };
  }

  clear(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec("DELETE FROM desktop_context_fts; DELETE FROM desktop_context;");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  #deleteIds(ids: string[]): void {
    if (ids.length === 0) return;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const deleteContext = this.#db.prepare("DELETE FROM desktop_context WHERE id = ?");
      const deleteFts = this.#db.prepare("DELETE FROM desktop_context_fts WHERE id = ?");
      for (const id of ids) {
        deleteFts.run(id);
        deleteContext.run(id);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function redactDesktopText(text: string): string {
  return text.replace(SECRET_RE, (_match, prefix: string) => `${prefix}[REDACTED]`);
}

function redactSnapshot(snapshot: DesktopContextSnapshot): DesktopContextSnapshot {
  return {
    ...snapshot,
    window: { ...snapshot.window, title: redactDesktopText(snapshot.window.title) },
    ...(snapshot.selectedText !== undefined ? { selectedText: redactDesktopText(snapshot.selectedText) } : {}),
    ...(snapshot.visibleText !== undefined ? { visibleText: redactDesktopText(snapshot.visibleText) } : {}),
  };
}

function contextSearchText(snapshot: DesktopContextSnapshot): string {
  return [snapshot.app.name, snapshot.window.title, snapshot.selectedText, snapshot.visibleText]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function toFtsQuery(query: string): string {
  return query.trim().split(/\s+/).filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function encryptPayload(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptPayload(key: Buffer, payload: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}
