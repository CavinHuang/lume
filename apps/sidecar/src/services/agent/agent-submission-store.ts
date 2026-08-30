import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentSavedFile, AgentSendInput, AgentSubmissionReceipt, AgentThreadMessageDispatchResult } from "@lume/shared";
import { stableSerialize } from "@lume/shared";
import { getConfigDir } from "../infra/config-paths";
import { writeLogRecord } from "../infra/logger";
import { openSqlite, type SqliteDatabase } from "../infra/open-sqlite";

interface SubmissionRow {
  client_submission_id: string;
  payload_hash: string;
  thread_id: string;
  status: AgentSubmissionReceipt["status"];
  mode: AgentThreadMessageDispatchResult["mode"] | null;
  queued_message_id: string | null;
  created_at: number;
  updated_at: number;
  error_code: string | null;
}

export class AgentSubmissionStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => number;

  constructor(input: { dbPath: string; now?: () => number }) {
    this.#db = openSqlite(input.dbPath);
    this.#now = input.now ?? Date.now;
    this.#db.exec("PRAGMA journal_mode = WAL;");
    migrateSubmissionStore(this.#db);
    const now = this.#now();
    this.#db.prepare(`
      UPDATE agent_submission
      SET status = 'paused', updated_at = ?, error_code = 'sidecar_restarted'
      WHERE status = 'queued'
    `).run(now);
    this.#db.prepare(`
      UPDATE agent_submission
      SET status = 'interrupted', updated_at = ?, error_code = 'sidecar_restarted'
      WHERE status IN ('preparing', 'accepted', 'started')
    `).run(now);
    this.#db.prepare(`
      UPDATE agent_submission_outbox
      SET status = CASE WHEN status = 'queued' THEN 'paused' ELSE 'interrupted' END,
          updated_at = ?
      WHERE status IN ('pending', 'started', 'queued')
    `).run(now);
  }

  begin(input: AgentSendInput): { receipt: AgentSubmissionReceipt; existing: boolean } | null {
    const id = input.clientSubmissionId?.trim();
    if (!id) return null;
    const payloadHash = hashAgentSubmission(input);
    const existing = this.get(id);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new Error("clientSubmissionId 已用于不同的提交内容");
      }
      return { receipt: existing, existing: true };
    }
    const now = this.#now();
    this.#db.prepare(`
      INSERT INTO agent_submission
        (client_submission_id, payload_hash, thread_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'preparing', ?, ?)
    `).run(id, payloadHash, input.threadId, now, now);
    return { receipt: this.get(id)!, existing: false };
  }

  accept(id: string, result: AgentThreadMessageDispatchResult, input?: AgentSendInput): AgentSubmissionReceipt {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        UPDATE agent_submission
        SET status = ?, mode = ?, queued_message_id = ?, updated_at = ?, error_code = NULL
        WHERE client_submission_id = ?
      `).run(
        result.mode === "queued" ? "queued" : "accepted",
        result.mode,
        result.queuedMessage?.id ?? null,
        this.#now(),
        id,
      );
      if (input) this.insertOutbox(id, input, result.mode === "queued" ? "queued" : "pending");
      if (result.mode === "sent") this.commitAttachmentLease(id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id)!;
  }

  start(id: string, input: AgentSendInput): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.insertOutbox(id, input, "started");
      this.#db.prepare(`
        UPDATE agent_submission SET status = 'started', updated_at = ?, error_code = NULL
        WHERE client_submission_id = ?
      `).run(this.#now(), id);
      this.commitAttachmentLease(id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  transition(id: string, status: AgentSubmissionReceipt["status"], errorCode?: string): void {
    this.#db.prepare(`
      UPDATE agent_submission
      SET status = ?, updated_at = ?, error_code = ?
      WHERE client_submission_id = ?
    `).run(status, this.#now(), errorCode ?? null, id);
    this.#db.prepare(`
      UPDATE agent_submission_outbox SET status = ?, updated_at = ?
      WHERE client_submission_id = ?
    `).run(status, this.#now(), id);
    if (status === "started") this.commitAttachmentLease(id);
    if (status === "rejected") this.abortAttachmentLease(id);
  }

  getPreparedAttachmentFiles(id: string): AgentSavedFile[] {
    const rows = this.#db.prepare(`
      SELECT attachment_id, filename, target_path, thread_path, ref_json,
             media_type, size_bytes, content_hash
      FROM agent_attachment_lease
      WHERE client_submission_id = ? AND status = 'prepared'
      ORDER BY created_at, target_path
    `).all(id) as Array<{
      attachment_id: string | null;
      filename: string;
      target_path: string;
      thread_path: string | null;
      ref_json: string | null;
      media_type: string | null;
      size_bytes: number | null;
      content_hash: string | null;
    }>;
    return rows.map((row) => ({
      ...(row.attachment_id ? { id: row.attachment_id } : {}),
      filename: row.filename,
      targetPath: row.target_path,
      ...(row.thread_path ? { threadPath: row.thread_path } : {}),
      ...(row.ref_json ? { ref: JSON.parse(row.ref_json) } : {}),
      ...(row.media_type ? { mediaType: row.media_type } : {}),
      ...(row.size_bytes !== null ? { size: row.size_bytes } : {}),
      ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    }));
  }

  prepareAttachmentLease(id: string, threadId: string, files: AgentSavedFile[]): void {
    const now = this.#now();
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO agent_attachment_lease
        (client_submission_id, thread_id, target_path, attachment_id, filename, thread_path,
         ref_json, media_type, size_bytes, content_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
    `);
    for (const file of files) {
      insert.run(
        id,
        threadId,
        file.targetPath,
        file.id ?? null,
        file.filename,
        file.threadPath ?? null,
        file.ref ? JSON.stringify(file.ref) : null,
        file.mediaType ?? null,
        file.size ?? null,
        file.contentHash ?? null,
        now,
        now,
      );
    }
  }

  getQueuedInputs(threadId: string): AgentSendInput[] {
    const rows = this.#db.prepare(`
      SELECT payload_json FROM agent_submission_outbox
      WHERE thread_id = ? AND status IN ('queued', 'paused')
      ORDER BY created_at
    `).all(threadId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as AgentSendInput);
  }

  countQueued(threadId: string): number {
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS count FROM agent_submission_outbox
      WHERE thread_id = ? AND status IN ('queued', 'paused')
    `).get(threadId) as { count: number };
    return row.count;
  }

  resumeQueued(threadId: string): void {
    const now = this.#now();
    this.#db.prepare(`UPDATE agent_submission SET status = 'queued', updated_at = ?, error_code = NULL WHERE thread_id = ? AND status = 'paused'`).run(now, threadId);
    this.#db.prepare(`UPDATE agent_submission_outbox SET status = 'queued', updated_at = ? WHERE thread_id = ? AND status = 'paused'`).run(now, threadId);
  }

  pauseQueued(threadId: string): void {
    const now = this.#now();
    this.#db.prepare(`UPDATE agent_submission SET status = 'paused', updated_at = ? WHERE thread_id = ? AND status = 'queued'`).run(now, threadId);
    this.#db.prepare(`UPDATE agent_submission_outbox SET status = 'paused', updated_at = ? WHERE thread_id = ? AND status = 'queued'`).run(now, threadId);
  }

  abortAttachmentLease(id: string): void {
    const rows = this.#db.prepare(`
      SELECT thread_id, target_path FROM agent_attachment_lease
      WHERE client_submission_id = ? AND status = 'prepared'
    `).all(id) as Array<{ thread_id: string; target_path: string }>;
    for (const row of rows) {
      if (existsSync(row.target_path)) rmSync(row.target_path, { force: true });
    }
    this.#db.prepare(`
      UPDATE agent_attachment_lease SET status = 'aborted', updated_at = ?
      WHERE client_submission_id = ? AND status = 'prepared'
    `).run(this.#now(), id);
    if (rows.length > 0) {
      writeLogRecord({
        level: "info",
        kind: "trace",
        context: "agent.attachment",
        event: "attachment.lease.aborted",
        message: "prepared attachment lease aborted",
        status: "cancelled",
        threadId: rows[0]?.thread_id,
        data: { clientSubmissionId: id, attachmentCount: rows.length }
      });
    }
  }

  commitAttachmentLease(id: string): void {
    const rows = this.#db.prepare(`
      SELECT thread_id FROM agent_attachment_lease
      WHERE client_submission_id = ? AND status = 'prepared'
    `).all(id) as Array<{ thread_id: string }>;
    this.#db.prepare(`
      UPDATE agent_attachment_lease SET status = 'committed', updated_at = ?
      WHERE client_submission_id = ? AND status = 'prepared'
    `).run(this.#now(), id);
    if (rows.length > 0) {
      writeLogRecord({
        level: "info",
        kind: "trace",
        context: "agent.attachment",
        event: "attachment.lease.committed",
        message: "prepared attachment lease committed",
        status: "ok",
        threadId: rows[0]?.thread_id,
        data: { clientSubmissionId: id, attachmentCount: rows.length }
      });
    }
  }

  get(id: string): AgentSubmissionReceipt | undefined {
    const row = this.#db.prepare(`
      SELECT client_submission_id, payload_hash, thread_id, status, mode,
             queued_message_id, created_at, updated_at, error_code
      FROM agent_submission WHERE client_submission_id = ?
    `).get(id) as SubmissionRow | undefined;
    return row ? rowToReceipt(row) : undefined;
  }

  deleteThread(threadId: string): void {
    const prepared = this.#db.prepare(`
      SELECT DISTINCT client_submission_id
      FROM agent_attachment_lease
      WHERE status = 'prepared' AND thread_id = ?
    `).all(threadId) as Array<{ client_submission_id: string }>;
    for (const row of prepared) this.abortAttachmentLease(row.client_submission_id);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        DELETE FROM agent_attachment_lease
        WHERE thread_id = ?
      `).run(threadId);
      this.#db.prepare("DELETE FROM agent_submission WHERE thread_id = ?").run(threadId);
      this.#db.prepare("DELETE FROM agent_submission_outbox WHERE thread_id = ?").run(threadId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.#db.close();
  }

  private insertOutbox(id: string, input: AgentSendInput, status: string): void {
    const now = this.#now();
    this.#db.prepare(`
      INSERT INTO agent_submission_outbox
        (client_submission_id, thread_id, payload_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_submission_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(id, input.threadId, JSON.stringify(input), status, now, now);
  }
}

function migrateSubmissionStore(db: SqliteDatabase): void {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS agent_submission (
      client_submission_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT,
      queued_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_submission_thread_updated
      ON agent_submission(thread_id, updated_at);
    CREATE TABLE IF NOT EXISTS agent_attachment_lease (
      client_submission_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      target_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      thread_path TEXT,
      ref_json TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (client_submission_id, target_path)
    );
    CREATE TABLE IF NOT EXISTS agent_submission_outbox (
      client_submission_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    COMMIT;
  `);

  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      ensureColumn(db, "agent_attachment_lease", "thread_id", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "agent_attachment_lease", "attachment_id", "TEXT");
      ensureColumn(db, "agent_attachment_lease", "media_type", "TEXT");
      ensureColumn(db, "agent_attachment_lease", "size_bytes", "INTEGER");
      ensureColumn(db, "agent_attachment_lease", "content_hash", "TEXT");
      db.exec("PRAGMA user_version = 2;");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const integrity = db.prepare("PRAGMA quick_check").get() as Record<string, string>;
  if (!Object.values(integrity).includes("ok")) {
    throw new Error("agent-submissions.sqlite 完整性检查失败");
  }
}

function ensureColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

let singleton: AgentSubmissionStore | undefined;
let singletonPath: string | undefined;

export function getAgentSubmissionStore(): AgentSubmissionStore {
  const dbPath = join(getConfigDir(), "agent-submissions.sqlite");
  if (!singleton || singletonPath !== dbPath) {
    singleton?.close();
    singleton = new AgentSubmissionStore({ dbPath });
    singletonPath = dbPath;
  }
  return singleton;
}

export function resetAgentSubmissionStoreForTests(): void {
  singleton?.close();
  singleton = undefined;
  singletonPath = undefined;
}

export function hashAgentSubmission(input: AgentSendInput): string {
  const payload = {
    threadId: input.threadId,
    userMessage: input.userMessage,
    messageParts: input.messageParts,
    messageAttachments: input.messageAttachments,
    commentAttachments: input.commentAttachments,
    modelRef: input.modelRef,
    channelId: input.channelId,
    modelId: input.modelId,
    permissionMode: input.permissionMode,
    thinkingLevel: input.thinkingLevel,
    workspaceId: input.workspaceId,
    messageMetadata: input.messageMetadata,
  };
  return createHash("sha256").update(stableSerialize(payload)).digest("hex");
}

function rowToReceipt(row: SubmissionRow): AgentSubmissionReceipt {
  return {
    clientSubmissionId: row.client_submission_id,
    payloadHash: row.payload_hash,
    threadId: row.thread_id,
    status: row.status,
    ...(row.mode ? { mode: row.mode } : {}),
    ...(row.queued_message_id ? { queuedMessageId: row.queued_message_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}
