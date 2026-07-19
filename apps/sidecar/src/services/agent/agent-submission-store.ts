import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AgentSavedFile, AgentSendInput, AgentSubmissionReceipt, AgentThreadMessageDispatchResult } from "@lume/shared";
import { getConfigDir } from "../infra/config-paths";
import { writeLogRecord } from "../infra/logger";

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

interface DatabaseStatementLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): DatabaseStatementLike;
  close(): void;
}

export class AgentSubmissionStore {
  readonly #db: DatabaseSyncLike;
  readonly #now: () => number;

  constructor(input: { dbPath: string; now?: () => number }) {
    const runtimeRequire = createRequire(import.meta.url);
    let Database: new (path: string) => DatabaseSyncLike;
    try {
      Database = (runtimeRequire("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncLike }).DatabaseSync;
    } catch {
      Database = (runtimeRequire("bun:sqlite") as { Database: new (path: string) => DatabaseSyncLike }).Database;
    }
    this.#db = new Database(input.dbPath);
    this.#now = input.now ?? Date.now;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
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
        thread_id TEXT NOT NULL,
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
    `);
    const leaseColumns = this.#db.prepare("PRAGMA table_info(agent_attachment_lease)")
      .all() as unknown as Array<{ name: string }>;
    if (!leaseColumns.some((column) => column.name === "thread_id")) {
      this.#db.exec("ALTER TABLE agent_attachment_lease ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';");
    }
    const now = this.#now();
    const staleLeases = this.#db.prepare(
      "SELECT target_path FROM agent_attachment_lease WHERE status = 'prepared'",
    ).all() as unknown as Array<{ target_path: string }>;
    for (const lease of staleLeases) {
      if (existsSync(lease.target_path)) rmSync(lease.target_path, { force: true });
    }
    this.#db.prepare(`
      UPDATE agent_attachment_lease SET status = 'aborted', updated_at = ? WHERE status = 'prepared'
    `).run(now);
    this.#db.prepare(`
      UPDATE agent_submission
      SET status = CASE WHEN status = 'queued' THEN 'restart_dropped' ELSE 'interrupted' END,
          updated_at = ?,
          error_code = 'sidecar_restarted'
      WHERE status IN ('preparing', 'accepted', 'started', 'queued')
    `).run(now);
    this.#db.prepare(`
      UPDATE agent_submission_outbox
      SET status = 'interrupted', updated_at = ?
      WHERE status IN ('pending', 'started')
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
      if (result.mode === "sent" && input) this.insertOutbox(id, input, "pending");
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
      SELECT filename, target_path, thread_path, ref_json
      FROM agent_attachment_lease
      WHERE client_submission_id = ? AND status = 'prepared'
      ORDER BY created_at, target_path
    `).all(id) as unknown as Array<{
      filename: string;
      target_path: string;
      thread_path: string | null;
      ref_json: string | null;
    }>;
    return rows.map((row) => ({
      filename: row.filename,
      targetPath: row.target_path,
      ...(row.thread_path ? { threadPath: row.thread_path } : {}),
      ...(row.ref_json ? { ref: JSON.parse(row.ref_json) } : {}),
    }));
  }

  prepareAttachmentLease(id: string, threadId: string, files: AgentSavedFile[]): void {
    const now = this.#now();
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO agent_attachment_lease
        (client_submission_id, thread_id, target_path, filename, thread_path, ref_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
    `);
    for (const file of files) {
      insert.run(
        id,
        threadId,
        file.targetPath,
        file.filename,
        file.threadPath ?? null,
        file.ref ? JSON.stringify(file.ref) : null,
        now,
        now,
      );
    }
  }

  abortAttachmentLease(id: string): void {
    const rows = this.#db.prepare(`
      SELECT thread_id, target_path FROM agent_attachment_lease
      WHERE client_submission_id = ? AND status = 'prepared'
    `).all(id) as unknown as Array<{ thread_id: string; target_path: string }>;
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
    `).all(id) as unknown as Array<{ thread_id: string }>;
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
    `).get(id) as unknown as SubmissionRow | undefined;
    return row ? rowToReceipt(row) : undefined;
  }

  deleteThread(threadId: string): void {
    const prepared = this.#db.prepare(`
      SELECT DISTINCT client_submission_id
      FROM agent_attachment_lease
      WHERE status = 'prepared' AND thread_id = ?
    `).all(threadId) as unknown as Array<{ client_submission_id: string }>;
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

export function hashAgentSubmission(input: AgentSendInput): string {
  const payload = {
    threadId: input.threadId,
    userMessage: input.userMessage,
    messageParts: input.messageParts,
    messageAttachments: input.messageAttachments,
    modelRef: input.modelRef,
    channelId: input.channelId,
    modelId: input.modelId,
    permissionMode: input.permissionMode,
    thinkingLevel: input.thinkingLevel,
    workspaceId: input.workspaceId,
    messageMetadata: input.messageMetadata,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
