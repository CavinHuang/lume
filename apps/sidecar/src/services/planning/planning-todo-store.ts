import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  PlanningTodo,
  PlanningTodoChangeEvent,
  PlanningTodoCreateInput,
  PlanningTodoListInput,
  PlanningTodoListResult,
  PlanningTodoMutationResult,
  PlanningTodoPurgeInput,
  PlanningOperationEnvelope,
  PlanningOperationKind,
  PlanningOperationTransition,
  PlanningTodoPriority,
  PlanningTodoRefPart,
  PlanningTodoRevisionInput,
  PlanningTodoUpdateInput,
} from "@lume/shared";
import { createPlanningOperation, normalizePlanningTodoTitle, reducePlanningOperation, validatePlanningTodoDueFields } from "@lume/shared";
import { getConfigDir } from "../infra/config-paths";

interface Statement { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown; }
interface Db { exec(sql: string): void; prepare(sql: string): Statement; close(): void; }

interface TodoRow {
  id: string; title: string; normalized_title: string; description: string | null; status: PlanningTodo["status"];
  priority: PlanningTodoPriority; workspace_id: string | null; due_date: string | null; due_at: number | null;
  due_timezone: string | null; revision: number; created_at: number; updated_at: number;
  completed_at: number | null; deleted_at: number | null;
}

export class PlanningTodoConflictError extends Error {
  readonly code = "planning_todo_conflict";
  constructor(readonly latest: PlanningTodo) { super("Planning Todo 已被其他操作更新"); }
}

export class PlanningTodoNotFoundError extends Error {
  readonly code = "planning_todo_not_found";
  constructor() { super("Planning Todo 不存在或不可访问"); }
}

export class PlanningTodoStore {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #timezone: () => string;
  readonly #onChange?: (event: PlanningTodoChangeEvent) => void;
  readonly #dbPath: string;

  constructor(input: { dbPath: string; now?: () => number; timezone?: () => string; onChange?: (event: PlanningTodoChangeEvent) => void }) {
    this.#dbPath = input.dbPath;
    mkdirSync(dirname(input.dbPath), { recursive: true });
    const runtimeRequire = createRequire(import.meta.url);
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
      const Database = (runtimeRequire("bun:sqlite") as { Database: new (path: string) => { exec(sql: string): void; query(sql: string): Statement; close(): void } }).Database;
      const db = new Database(input.dbPath);
      this.#db = { exec: (sql) => db.exec(sql), prepare: (sql) => db.query(sql), close: () => db.close() };
    } else {
      const DatabaseSync = (runtimeRequire("node:sqlite") as { DatabaseSync: new (path: string) => Db }).DatabaseSync;
      this.#db = new DatabaseSync(input.dbPath);
    }
    this.#now = input.now ?? Date.now;
    this.#timezone = input.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.#onChange = input.onChange;
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrate(this.#db);
  }

  get path(): string { return this.#dbPath; }

  list(input: PlanningTodoListInput = {}): PlanningTodoListResult {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.scope === "unassigned") where.push("workspace_id IS NULL");
    else if (input.workspaceId && input.scope !== "all") { where.push("workspace_id = ?"); params.push(input.workspaceId); }
    if (input.view === "trash") where.push("deleted_at IS NOT NULL");
    else if (input.view === "completed") where.push("deleted_at IS NULL AND status = 'completed'");
    else if (input.view === "open" || input.view === "today" || input.view === "upcoming" || !input.view) where.push("deleted_at IS NULL AND status = 'open'");
    if (input.search?.trim()) { where.push("(title LIKE ? OR description LIKE ?)"); const query = `%${input.search.trim()}%`; params.push(query, query); }
    const rows = this.#db.prepare(`SELECT * FROM planning_todo${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`).all(...params) as unknown as TodoRow[];
    const timezone = this.#timezone();
    const today = localDate(this.#now(), timezone);
    // #593①:bucket 逐条预计算——此前 filter 与 sort 比较器内每次重算 dueBucket,
    // 有 dueAt 的条目反复走 Intl 格式化,O(n log n) 次比较放大成构造风暴
    const decorated = rows.map(rowToTodo).map((todo) => ({ todo, bucket: dueBucket(todo, today, timezone) }));
    const filtered = decorated
      .filter(({ bucket }) => {
        if (input.view === "today") return bucket <= 1;
        if (input.view === "upcoming") return bucket >= 2;
        return true;
      })
      .sort((left, right) => left.bucket - right.bucket
        || priorityWeight(right.todo.priority) - priorityWeight(left.todo.priority)
        || right.todo.updatedAt - left.todo.updatedAt
        || left.todo.id.localeCompare(right.todo.id))
      .map(({ todo }) => todo);
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const items = filtered.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + limit);
    const nextOffset = (Number.isFinite(offset) ? offset : 0) + items.length;
    return { schemaVersion: 1, items, ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}) };
  }

  get(todoId: string, includeDeleted = true): PlanningTodo {
    const row = this.#db.prepare("SELECT * FROM planning_todo WHERE id = ?").get(todoId) as unknown as TodoRow | undefined;
    if (!row || (!includeDeleted && row.deleted_at !== null)) throw new PlanningTodoNotFoundError();
    return rowToTodo(row);
  }

  create(input: PlanningTodoCreateInput): PlanningTodoMutationResult {
    const title = input.title.trim();
    if (!title) throw new Error("Todo 标题不能为空");
    validatePlanningTodoDueFields(input);
    const normalizedTitle = normalizePlanningTodoTitle(title);
    const now = this.#now();
    const id = randomUUID();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      // 去重判定移入事务内：并发同名创建在 BEGIN IMMEDIATE 串行化下走去重返回，
      // 而非第二个事务撞裸 SQLITE UNIQUE 约束（#647 P2-17）
      const existing = this.#db.prepare(`SELECT * FROM planning_todo WHERE normalized_title = ? AND status = 'open' AND deleted_at IS NULL AND (workspace_id = ? OR (workspace_id IS NULL AND ? IS NULL)) LIMIT 1`).get(normalizedTitle, input.workspaceId ?? null, input.workspaceId ?? null) as unknown as TodoRow | undefined;
      if (existing) {
        this.#db.exec("COMMIT");
        return { schemaVersion: 1, operation: "create", todo: rowToTodo(existing), deduplicated: true };
      }
      this.#db.prepare(`INSERT INTO planning_todo (id,title,normalized_title,description,status,priority,workspace_id,due_date,due_at,due_timezone,revision,created_at,updated_at,completed_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,NULL,NULL)`).run(id, title, normalizedTitle, input.description?.trim() || null, "open", input.priority ?? "none", input.workspaceId ?? null, input.dueDate ?? null, input.dueAt ?? null, input.dueTimezone ?? null, now, now);
      this.#syncDueReminder(id, input.dueAt, now);
      const eventSeq = this.#event(id, "created", now, { after: this.get(id) });
      this.#db.exec("COMMIT");
      const todo = this.get(id);
      this.#publish({ eventSeq, todoId: id, workspaceId: todo.workspaceId, operation: "created", resources: ["todos", "reminders"], updatedAt: now });
      return { schemaVersion: 1, operation: "create", todo, eventSeq };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  update(input: PlanningTodoUpdateInput): PlanningTodoMutationResult { return this.#mutate(input, "update", (todo, now) => applyPatch(todo, input.patch, now)); }
  complete(input: PlanningTodoRevisionInput): PlanningTodoMutationResult { return this.#mutate(input, "complete", (todo, now) => ({ ...todo, status: "completed", completedAt: now, revision: todo.revision + 1, updatedAt: now })); }
  reopen(input: PlanningTodoRevisionInput): PlanningTodoMutationResult { return this.#mutate(input, "reopen", (todo, now) => ({ ...todo, status: "open", completedAt: undefined, revision: todo.revision + 1, updatedAt: now })); }
  delete(input: PlanningTodoRevisionInput): PlanningTodoMutationResult { return this.#mutate(input, "delete", (todo, now) => ({ ...todo, deletedAt: now, revision: todo.revision + 1, updatedAt: now })); }
  restore(input: PlanningTodoRevisionInput): PlanningTodoMutationResult { return this.#mutate(input, "restore", (todo, now) => ({ ...todo, deletedAt: undefined, revision: todo.revision + 1, updatedAt: now })); }

  purge(input: PlanningTodoPurgeInput): PlanningTodoMutationResult {
    const previous = this.get(input.todoId);
    if (previous.revision !== input.expectedRevision) throw new PlanningTodoConflictError(previous);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const eventSeq = this.#event(input.todoId, "purged", this.#now(), { before: previous });
      this.#db.prepare("DELETE FROM planning_reminder WHERE target_type='todo' AND target_id=?").run(input.todoId);
      this.#db.prepare("DELETE FROM planning_todo_link WHERE todo_id = ?").run(input.todoId);
      this.#db.prepare("DELETE FROM planning_todo_event WHERE todo_id = ?").run(input.todoId);
      this.#db.prepare("DELETE FROM planning_todo WHERE id = ?").run(input.todoId);
      this.#db.exec("COMMIT");
      this.#publish({ eventSeq, todoId: input.todoId, workspaceId: previous.workspaceId, operation: "purged", resources: ["todos", "calendar_events", "reminders"], updatedAt: this.#now() });
      return { schemaVersion: 1, operation: "purge", previous, eventSeq };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  count(workspaceId?: string): number {
    const row = workspaceId === undefined
      ? this.#db.prepare("SELECT COUNT(*) AS count FROM planning_todo WHERE deleted_at IS NULL AND status = 'open'").get()
      : this.#db.prepare("SELECT COUNT(*) AS count FROM planning_todo WHERE workspace_id = ? AND deleted_at IS NULL AND status = 'open'").get(workspaceId);
    return Number((row as { count: number }).count);
  }

  snapshotWorkspaceTodos(workspaceId: string): PlanningTodo[] {
    return (this.#db.prepare("SELECT * FROM planning_todo WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId) as unknown as TodoRow[]).map(rowToTodo);
  }

  restoreWorkspaceSnapshot(snapshot: readonly PlanningTodo[], operationId: string): void {
    if (snapshot.length === 0) return;
    const now = this.#now();
    const eventSeqs = new Map<string, number>();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const todo of snapshot) {
        this.#db.prepare(`UPDATE planning_todo SET title=?, normalized_title=?, description=?, status=?, priority=?, workspace_id=?, due_date=?, due_at=?, due_timezone=?, revision=revision+1, updated_at=?, completed_at=?, deleted_at=? WHERE id=?`).run(
          todo.title, todo.normalizedTitle, todo.description ?? null, todo.status, todo.priority,
          todo.workspaceId ?? null, todo.dueDate ?? null, todo.dueAt ?? null, todo.dueTimezone ?? null,
          now, todo.completedAt ?? null, todo.deletedAt ?? null, todo.id
        );
        eventSeqs.set(todo.id, this.#event(todo.id, "project_compensated", now, { restored: todo }, operationId, "compensating"));
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
    for (const todo of snapshot) this.#publish({ eventSeq: eventSeqs.get(todo.id)!, todoId: todo.id, workspaceId: todo.workspaceId, operation: "project_compensated", updatedAt: now });
  }

  removeWorkspace(workspaceId: string, mode: "keepHistory" | "deleteLumeData"): { count: number; conflicts: number } {
    const rows = this.#db.prepare("SELECT * FROM planning_todo WHERE workspace_id = ?").all(workspaceId) as unknown as TodoRow[];
    let conflicts = 0;
    const now = this.#now();
    const eventSeqs = new Map<string, number>();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        let title = row.title;
        let normalized = row.normalized_title;
        if (mode === "keepHistory" && row.status === "open") {
          const exists = this.#db.prepare("SELECT id FROM planning_todo WHERE workspace_id IS NULL AND normalized_title = ? AND status = 'open' AND deleted_at IS NULL").get(normalized);
          if (exists) {
            conflicts++;
            title = `${title}（来自项目 ${workspaceId}）`;
            normalized = normalizePlanningTodoTitle(title);
            let suffix = 2;
            while (this.#db.prepare("SELECT id FROM planning_todo WHERE workspace_id IS NULL AND normalized_title = ? AND status = 'open' AND deleted_at IS NULL").get(normalized)) normalized = normalizePlanningTodoTitle(`${title} ${suffix++}`);
          }
        }
        const deletedAt = mode === "deleteLumeData" ? now : null;
        this.#db.prepare("UPDATE planning_todo SET title=?, normalized_title=?, workspace_id=NULL, deleted_at=?, revision=revision+1, updated_at=? WHERE id=?").run(title, normalized, deletedAt, now, row.id);
        // deleteLumeData 软删后 pending 提醒成为 targetSummary 永不可见的僵尸行，
        // 与单条 delete 同语义收口（#647 P2-15）
        if (mode === "deleteLumeData") {
          this.#db.prepare("UPDATE planning_reminder SET status='completed',updated_at=? WHERE target_type='todo' AND target_id=? AND status='pending'").run(now, row.id);
        }
        eventSeqs.set(row.id, this.#event(row.id, mode === "keepHistory" ? "moved_project" : "project_deleted", now, { before: row, originalTitle: row.title, afterWorkspaceId: null, deletedAt }));
      }
      this.#db.exec("COMMIT");
      // deleteLumeData 收口了提醒状态，发布需带 reminders 标签驱动 rail/日历重拉（#647 P2-15）
      for (const row of rows) this.#publish({ eventSeq: eventSeqs.get(row.id) ?? 0, todoId: row.id, operation: mode === "keepHistory" ? "moved_project" : "project_deleted", resources: ["todos", "reminders"], updatedAt: now });
      return { count: rows.length, conflicts };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  link(todoId: string, input: { threadId: string; messageId?: string; runId?: string; relation: PlanningTodoRefPart["relation"]; lifecycle?: "active" | "trashed" | "tombstone" }): void {
    if (!input.threadId) throw new Error("threadId is required");
    if (input.relation === "primary" && input.messageId) throw new Error("primary link cannot have messageId");
    if (input.relation === "mentioned" && !input.messageId) throw new Error("mentioned link requires messageId");
    const now = this.#now();
    this.#db.prepare(`INSERT INTO planning_todo_link (todo_id,thread_id,message_id,run_id,relation,lifecycle,first_referenced_at,last_referenced_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET run_id=COALESCE(excluded.run_id,planning_todo_link.run_id), lifecycle=excluded.lifecycle, last_referenced_at=excluded.last_referenced_at`).run(todoId, input.threadId, input.messageId ?? null, input.runId ?? null, input.relation, input.lifecycle ?? "active", now, now);
  }

  tombstoneThreadLinks(threadId: string): void { this.#db.prepare("UPDATE planning_todo_link SET lifecycle = 'tombstone' WHERE thread_id = ?").run(threadId); }
  snapshotThreadLinks(threadId: string): Array<{ todoId: string; threadId: string; messageId?: string; runId?: string; relation: PlanningTodoRefPart["relation"]; lifecycle: "active" | "trashed" | "tombstone" }> {
    const rows = this.#db.prepare("SELECT todo_id AS todoId, thread_id AS threadId, message_id AS messageId, run_id AS runId, relation, lifecycle FROM planning_todo_link WHERE thread_id = ?").all(threadId) as Array<{ todoId: string; threadId: string; messageId: string | null; runId: string | null; relation: PlanningTodoRefPart["relation"]; lifecycle: "active" | "trashed" | "tombstone" }>;
    return rows.map((row) => ({ todoId: row.todoId, threadId: row.threadId, ...(row.messageId ? { messageId: row.messageId } : {}), ...(row.runId ? { runId: row.runId } : {}), relation: row.relation, lifecycle: row.lifecycle }));
  }
  restoreThreadLinkSnapshot(snapshot: readonly { todoId: string; threadId: string; messageId?: string; runId?: string; relation: PlanningTodoRefPart["relation"]; lifecycle: "active" | "trashed" | "tombstone" }[]): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try { for (const link of snapshot) this.#db.prepare("UPDATE planning_todo_link SET lifecycle = ? WHERE todo_id = ? AND thread_id = ? AND relation = ? AND ((message_id = ?) OR (message_id IS NULL AND ? IS NULL))").run(link.lifecycle, link.todoId, link.threadId, link.relation, link.messageId ?? null, link.messageId ?? null); this.#db.exec("COMMIT"); }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
  }
  markThreadLinksTrashed(threadId: string): void { this.#db.prepare("UPDATE planning_todo_link SET lifecycle = 'trashed' WHERE thread_id = ? AND lifecycle = 'active'").run(threadId); }
  listPrimaryThreads(todoId: string): Array<{ threadId: string; lastReferencedAt: number; lifecycle: string }> {
    return this.#db.prepare("SELECT thread_id AS threadId, last_referenced_at AS lastReferencedAt, lifecycle FROM planning_todo_link WHERE todo_id = ? AND relation = 'primary' ORDER BY last_referenced_at DESC").all(todoId) as unknown as Array<{ threadId: string; lastReferencedAt: number; lifecycle: string }>;
  }
  listPrimaryTodosForThread(threadId: string): PlanningTodo[] {
    const rows = this.#db.prepare("SELECT todo_id AS todoId FROM planning_todo_link WHERE thread_id = ? AND relation = 'primary' AND lifecycle = 'active' ORDER BY last_referenced_at DESC").all(threadId) as Array<{ todoId: string }>;
    return rows.flatMap(({ todoId }) => {
      try {
        const todo = this.get(todoId);
        return todo.status === "open" && !todo.deletedAt ? [todo] : [];
      } catch { return []; }
    });
  }
  getOperation(operationId: string): PlanningOperationEnvelope | undefined {
    const rows = this.#db.prepare("SELECT payload_json FROM planning_todo_event WHERE operation_id = ? ORDER BY seq DESC").all(operationId) as Array<{ payload_json: string }>;
    for (const row of rows) {
      try {
        const envelope = (JSON.parse(row.payload_json) as { envelope?: PlanningOperationEnvelope }).envelope;
        if (envelope) return envelope;
      } catch { /* skip malformed or non-envelope audit events */ }
    }
    return undefined;
  }
  listRecoverableOperations(kinds: readonly PlanningOperationKind[]): PlanningOperationEnvelope[] {
    const rows = this.#db.prepare("SELECT operation_id, payload_json FROM planning_todo_event WHERE operation_id IS NOT NULL ORDER BY seq DESC").all() as Array<{ operation_id: string; payload_json: string }>;
    const seen = new Set<string>();
    const result: PlanningOperationEnvelope[] = [];
    for (const row of rows) {
      if (seen.has(row.operation_id)) continue;
      try {
        const envelope = (JSON.parse(row.payload_json) as { envelope?: PlanningOperationEnvelope }).envelope;
        if (!envelope) continue;
        seen.add(row.operation_id);
        if (kinds.includes(envelope.kind) && !["completed", "compensated", "failed"].includes(envelope.status)) result.push(envelope);
      } catch { /* ignore malformed historical operation rows */ }
    }
    return result;
  }
  reserveOperation(input: { operationId: string; kind: PlanningOperationKind; todoId?: string; threadId?: string; clientSubmissionId?: string }): PlanningOperationEnvelope {
    const existing = this.getOperation(input.operationId);
    if (existing) return existing;
    const envelope = createPlanningOperation({ ...input, updatedAt: this.#now() });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#event(input.todoId, input.kind, envelope.updatedAt, { envelope }, input.operationId, envelope.phase);
      this.#db.exec("COMMIT");
      return envelope;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      const raced = this.getOperation(input.operationId);
      if (raced) return raced;
      throw error;
    }
  }
  isTrustedPrimarySubmission(input: { operationId: string; clientSubmissionId: string; threadId: string; todoId?: string }): boolean {
    const operation = this.getOperation(input.operationId);
    if (!operation || (operation.kind !== "start" && operation.kind !== "continue")) return false;
    if (operation.clientSubmissionId !== input.clientSubmissionId || operation.threadId !== input.threadId || (input.todoId !== undefined && operation.todoId !== input.todoId)) return false;
    const rows = this.#db.prepare("SELECT payload_json FROM planning_todo_event WHERE operation_id = ? AND operation IN ('start','continue') ORDER BY seq DESC").all(input.operationId) as Array<{ payload_json: string }>;
    return rows.some((row) => {
      try {
        const envelope = (JSON.parse(row.payload_json) as { envelope?: PlanningOperationEnvelope }).envelope;
        return Boolean(envelope
          && envelope.operationId === input.operationId
          && envelope.clientSubmissionId === input.clientSubmissionId
          && envelope.threadId === input.threadId
          && (!input.todoId || envelope.todoId === input.todoId)
          && ["reserved", "thread_created", "submission_accepted", "link_committed", "link_touched", "reconciled", "finalized"].includes(envelope.phase));
      } catch { return false; }
    });
  }
  advanceOperation(operationId: string, transition: PlanningOperationTransition): PlanningOperationEnvelope {
    const current = this.getOperation(operationId);
    if (!current) throw new Error(`planning operation not found: ${operationId}`);
    const envelope = reducePlanningOperation(current, { ...transition, updatedAt: transition.updatedAt ?? this.#now() });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#event(envelope.todoId, envelope.kind, envelope.updatedAt, { envelope }, operationId, envelope.phase);
      this.#db.exec("COMMIT");
      return envelope;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); this.#db.close(); }

  #mutate(input: PlanningTodoRevisionInput | PlanningTodoUpdateInput, operation: PlanningTodoMutationResult["operation"], next: (todo: PlanningTodo, now: number) => PlanningTodo): PlanningTodoMutationResult {
    const before = this.get(input.todoId);
    if (before.revision !== input.expectedRevision) throw new PlanningTodoConflictError(before);
    const candidate = next(before, this.#now());
    validatePlanningTodoDueFields(candidate);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.#db.prepare(`UPDATE planning_todo SET title=?, normalized_title=?, description=?, status=?, priority=?, workspace_id=?, due_date=?, due_at=?, due_timezone=?, revision=?, updated_at=?, completed_at=?, deleted_at=? WHERE id=? AND revision=?`).run(candidate.title, normalizePlanningTodoTitle(candidate.title), candidate.description ?? null, candidate.status, candidate.priority, candidate.workspaceId ?? null, candidate.dueDate ?? null, candidate.dueAt ?? null, candidate.dueTimezone ?? null, candidate.revision, candidate.updatedAt, candidate.completedAt ?? null, candidate.deletedAt ?? null, candidate.id, input.expectedRevision) as { changes?: number };
      if (changed.changes === 0) throw new PlanningTodoConflictError(this.get(input.todoId));
      // 已完成 todo 再改期不得新造无人收口的 pending 提醒（评审发现的相邻预存洞）
      if (operation === "update" && before.dueAt !== candidate.dueAt && candidate.status !== "completed") this.#syncDueReminder(candidate.id, candidate.dueAt, candidate.updatedAt);
      // complete 只收口自动跟随的 due 提醒，用户手动建的提醒保留意图；
      // delete 仍连坐全部（回收站 todo 不应再触发任何提醒），restore 不复活手动提醒
      // （completed 状态无法区分两种收口来源，复活需额外记账——有意取舍）。
      // reopen/restore 时由 #syncDueReminder 为 open todo 重建 due 提醒（#647 P1-5）。
      if (operation === "complete") this.#db.prepare("UPDATE planning_reminder SET status='completed',updated_at=? WHERE target_type='todo' AND target_id=? AND status='pending' AND origin='todo_due_at'").run(candidate.updatedAt, candidate.id);
      if (operation === "delete") this.#db.prepare("UPDATE planning_reminder SET status='completed',updated_at=? WHERE target_type='todo' AND target_id=? AND status='pending'").run(candidate.updatedAt, candidate.id);
      if ((operation === "reopen" || operation === "restore") && candidate.dueAt !== undefined && candidate.status === "open") this.#syncDueReminder(candidate.id, candidate.dueAt, candidate.updatedAt);
      const eventSeq = this.#event(input.todoId, operation, candidate.updatedAt, { before, after: candidate });
      this.#db.exec("COMMIT");
      const todo = this.get(input.todoId);
      this.#publish({ eventSeq, todoId: todo.id, workspaceId: todo.workspaceId, operation, resources: ["todos", "reminders"], updatedAt: todo.updatedAt });
      return { schemaVersion: 1, operation, todo, previous: before, eventSeq };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #event(todoId: string | undefined, operation: string, now: number, payload: Record<string, unknown>, operationId?: string, phase = "finalized"): number {
    this.#db.prepare("INSERT INTO planning_todo_event (todo_id,operation,phase,operation_id,payload_json,created_at) VALUES (?,?,?,?,?,?)").run(todoId ?? null, operation, phase, operationId ?? null, JSON.stringify(payload), now);
    const row = this.#db.prepare("SELECT seq FROM planning_todo_event WHERE rowid = last_insert_rowid()").get() as { seq: number };
    return row.seq;
  }

  #syncDueReminder(todoId: string, dueAt: number | undefined, now: number): void {
    const existing = this.#db.prepare("SELECT id,snoozed_until FROM planning_reminder WHERE target_type='todo' AND target_id=? AND origin='todo_due_at' AND status='pending' ORDER BY created_at LIMIT 1").get(todoId) as { id: string; snoozed_until: number | null } | undefined;
    if (dueAt === undefined) { this.#db.prepare("DELETE FROM planning_reminder WHERE target_type='todo' AND target_id=? AND origin='todo_due_at' AND status='pending'").run(todoId); return; }
    // 已存在的自动提醒（含被 snooze 过的）跟随新 dueAt：清除推迟态，
    // 避免旧时间弹一次 + 新时间再弹一次的双触发（#647 P1-4）
    if (existing) { this.#db.prepare("UPDATE planning_reminder SET trigger_at=?,snoozed_until=NULL,last_notified_at=NULL,updated_at=? WHERE id=?").run(dueAt, now, existing.id); return; }
    this.#db.prepare("INSERT INTO planning_reminder (id,target_type,target_id,trigger_at,status,origin,created_at,updated_at) VALUES (?,'todo',?,?,'pending','todo_due_at',?,?)").run(randomUUID(), todoId, dueAt, now, now);
  }

  #publish(event: PlanningTodoChangeEvent): void { queueMicrotask(() => this.#onChange?.(event)); }
}

function migrate(db: Db): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = Number(versionRow?.user_version ?? Object.values(versionRow ?? {})[0] ?? 0);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (version === 0) {
      createSchema(db);
      db.exec("PRAGMA user_version = 3;");
    } else if (version === 1) {
      for (const index of ["planning_todo_open_title", "planning_todo_scope_status", "planning_todo_primary_thread", "planning_todo_mentioned_message", "planning_todo_link_todo", "planning_todo_event_todo", "planning_todo_event_reserved"]) db.exec(`DROP INDEX IF EXISTS ${index}`);
      db.exec("ALTER TABLE planning_todo RENAME TO planning_todo_v1; ALTER TABLE planning_todo_link RENAME TO planning_todo_link_v1; ALTER TABLE planning_todo_event RENAME TO planning_todo_event_v1;");
      createSchema(db);
      db.exec(`INSERT INTO planning_todo (id,title,normalized_title,description,status,priority,workspace_id,due_date,due_at,due_timezone,revision,created_at,updated_at,completed_at,deleted_at)
        SELECT id,title,normalized_title,description,status,
          CASE priority WHEN 'normal' THEN 'medium' WHEN 'urgent' THEN 'high' ELSE priority END,
          workspace_id,due_date,due_at,due_timezone,revision,created_at,updated_at,completed_at,deleted_at
        FROM planning_todo_v1;`);
      db.exec("INSERT INTO planning_todo_link SELECT * FROM planning_todo_link_v1;");
      db.exec("INSERT INTO planning_todo_event SELECT * FROM planning_todo_event_v1;");
      db.exec("DROP TABLE planning_todo_event_v1; DROP TABLE planning_todo_link_v1; DROP TABLE planning_todo_v1;");
      db.exec("PRAGMA user_version = 3;");
    } else if (version === 2) {
      createSchema(db);
      db.exec("PRAGMA user_version = 3;");
    } else if (version > 3) {
      throw new Error(`unsupported planning.sqlite user_version: ${version}`);
    } else {
      createSchema(db);
    }
    // #647 P2-14：isTrustedPrimarySubmission/getOperation 按 operation_id 直查的支撑索引（幂等创建）
    db.exec("CREATE INDEX IF NOT EXISTS planning_todo_event_operation ON planning_todo_event(operation_id, seq)");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the migration error */ }
    throw error;
  }
  const rows = db.prepare("PRAGMA quick_check").all();
  const values = rows.flatMap((row) => row && typeof row === "object" ? Object.values(row as Record<string, unknown>) : [row]).map(String);
  if (values.length === 0 || values.some((value) => value !== "ok")) throw new Error("planning.sqlite 完整性检查失败");
}

function createSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS planning_todo (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, normalized_title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL CHECK(status IN ('open','completed')), priority TEXT NOT NULL CHECK(priority IN ('none','low','medium','high')),
      workspace_id TEXT, due_date TEXT, due_at INTEGER, due_timezone TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      completed_at INTEGER, deleted_at INTEGER,
      CHECK ((due_date IS NULL) OR (due_at IS NULL AND due_timezone IS NULL)),
      CHECK ((due_at IS NULL AND due_timezone IS NULL) OR (due_at IS NOT NULL AND due_timezone IS NOT NULL)),
      CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS planning_todo_open_title ON planning_todo(COALESCE(workspace_id, '<unassigned>'), normalized_title) WHERE status = 'open' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS planning_todo_scope_status ON planning_todo(workspace_id,status,deleted_at,updated_at);
    CREATE TABLE IF NOT EXISTS planning_todo_link (
      todo_id TEXT NOT NULL REFERENCES planning_todo(id) ON DELETE CASCADE, thread_id TEXT NOT NULL,
      message_id TEXT, run_id TEXT, relation TEXT NOT NULL CHECK(relation IN ('primary','mentioned')),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','trashed','tombstone')),
      first_referenced_at INTEGER NOT NULL, last_referenced_at INTEGER NOT NULL,
      CHECK ((relation = 'primary' AND message_id IS NULL) OR (relation = 'mentioned' AND message_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS planning_todo_primary_thread ON planning_todo_link(thread_id) WHERE relation = 'primary';
    CREATE UNIQUE INDEX IF NOT EXISTS planning_todo_mentioned_message ON planning_todo_link(todo_id,message_id) WHERE relation = 'mentioned';
    CREATE INDEX IF NOT EXISTS planning_todo_link_todo ON planning_todo_link(todo_id,last_referenced_at);
    CREATE TABLE IF NOT EXISTS planning_todo_event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, todo_id TEXT, operation TEXT NOT NULL, phase TEXT NOT NULL,
      operation_id TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS planning_todo_event_todo ON planning_todo_event(todo_id,seq);
    CREATE UNIQUE INDEX IF NOT EXISTS planning_todo_event_reserved ON planning_todo_event(operation_id) WHERE operation_id IS NOT NULL AND phase = 'reserved';
    CREATE TABLE IF NOT EXISTS planning_group (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('todo','calendar')), name TEXT NOT NULL,
      normalized_name TEXT NOT NULL, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(scope, normalized_name)
    );
    CREATE TABLE IF NOT EXISTS planning_tag (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, color TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS planning_calendar_event (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, start_at INTEGER NOT NULL, end_at INTEGER,
      all_day INTEGER NOT NULL DEFAULT 0 CHECK(all_day IN (0,1)), group_id TEXT REFERENCES planning_group(id) ON DELETE SET NULL,
      workspace_id TEXT, todo_id TEXT REFERENCES planning_todo(id) ON DELETE SET NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK(end_at IS NULL OR end_at >= start_at)
    );
    CREATE INDEX IF NOT EXISTS planning_calendar_event_time ON planning_calendar_event(start_at,end_at);
    CREATE INDEX IF NOT EXISTS planning_calendar_event_workspace ON planning_calendar_event(workspace_id,start_at);
    CREATE TABLE IF NOT EXISTS planning_calendar_event_tag (
      event_id TEXT NOT NULL REFERENCES planning_calendar_event(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES planning_tag(id) ON DELETE CASCADE, PRIMARY KEY(event_id,tag_id)
    );
    CREATE TABLE IF NOT EXISTS planning_reminder (
      id TEXT PRIMARY KEY, target_type TEXT NOT NULL CHECK(target_type IN ('todo','calendar_event')), target_id TEXT NOT NULL,
      trigger_at INTEGER NOT NULL, snoozed_until INTEGER, status TEXT NOT NULL CHECK(status IN ('pending','acknowledged','completed')),
      origin TEXT NOT NULL CHECK(origin IN ('manual','todo_due_at')), acknowledged_at INTEGER, last_notified_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS planning_reminder_due ON planning_reminder(status,snoozed_until,trigger_at);
    CREATE INDEX IF NOT EXISTS planning_reminder_target ON planning_reminder(target_type,target_id);
  `);
}

function rowToTodo(row: TodoRow): PlanningTodo {
  return {
    id: row.id, title: row.title, normalizedTitle: row.normalized_title, ...(row.description ? { description: row.description } : {}),
    status: row.status, priority: row.priority, ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.due_date ? { dueDate: row.due_date } : {}), ...(row.due_at !== null ? { dueAt: row.due_at } : {}),
    ...(row.due_timezone ? { dueTimezone: row.due_timezone } : {}), revision: row.revision, createdAt: row.created_at,
    updatedAt: row.updated_at, ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}), ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
  };
}

function applyPatch(todo: PlanningTodo, patch: PlanningTodoUpdateInput["patch"], now: number): PlanningTodo {
  const next: PlanningTodo = { ...todo, revision: todo.revision + 1, updatedAt: now };
  if (patch.title !== undefined) { const title = patch.title.trim(); if (!title) throw new Error("Todo 标题不能为空"); next.title = title; }
  if (patch.description !== undefined) next.description = patch.description?.trim() || undefined;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.workspaceId !== undefined) next.workspaceId = patch.workspaceId ?? undefined;
  const hasDate = Object.prototype.hasOwnProperty.call(patch, "dueDate");
  const hasAt = Object.prototype.hasOwnProperty.call(patch, "dueAt");
  if (hasDate && hasAt && patch.dueDate !== null && patch.dueAt !== null) throw new Error("dueDate and dueAt are mutually exclusive");
  if (hasDate) {
    next.dueDate = patch.dueDate ?? undefined;
    if (patch.dueDate !== null) { next.dueAt = undefined; next.dueTimezone = undefined; }
  }
  if (hasAt) {
    next.dueAt = patch.dueAt ?? undefined;
    if (patch.dueAt === null) next.dueTimezone = undefined;
    else next.dueDate = undefined;
  }
  if (patch.dueTimezone !== undefined) next.dueTimezone = patch.dueTimezone ?? undefined;
  return next;
}

// #593①:Intl.DateTimeFormat 构造昂贵且 list/cron 热路径高频调用——formatter 按
// 时区复用(时区集合极小,缓存无界风险可忽略)
const localDateFormatters = new Map<string, Intl.DateTimeFormat>();

function localDate(timestamp: number, timezone: string): string {
  let formatter = localDateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    localDateFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(timestamp);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function dueBucket(todo: PlanningTodo, today: string, timezone: string): number {
  const date = todo.dueDate ?? (todo.dueAt === undefined ? undefined : localDate(todo.dueAt, timezone));
  if (!date) return 3;
  if (date < today) return 0;
  if (date === today) return 1;
  return 2;
}

function priorityWeight(priority: PlanningTodoPriority): number { return { none: 0, low: 1, medium: 2, high: 3 }[priority]; }

let singleton: PlanningTodoStore | undefined;
let singletonPath: string | undefined;

export function getPlanningTodoStore(input?: { onChange?: (event: PlanningTodoChangeEvent) => void }): PlanningTodoStore {
  const path = join(getConfigDir(), "planning", "planning.sqlite");
  if (!singleton || singletonPath !== path) {
    singleton?.close();
    singleton = new PlanningTodoStore({ dbPath: path, ...input });
    singletonPath = path;
  }
  return singleton;
}

export function planningTodoPath(): string { return join(getConfigDir(), "planning", "planning.sqlite"); }

export function closePlanningTodoStore(): void {
  singleton?.close();
  singleton = undefined;
  singletonPath = undefined;
}

export function resetPlanningTodoStoreForTests(): void { closePlanningTodoStore(); }
