import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  PlanningTodoConflictError,
  PlanningTodoStore,
} from "./planning-todo-store";

function withStore(run: (store: PlanningTodoStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "lume-planning-test-"));
  const store = new PlanningTodoStore({
    dbPath: join(root, "planning.sqlite"),
    now: () => 1_700_000_000_000,
    timezone: () => "Asia/Shanghai",
  });
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("PlanningTodoStore", () => {
  test("upgrades a v2 database with calendar and reminder tables", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-planning-v2-test-"));
    const dbPath = join(root, "planning.sqlite");
    try {
      const initial = new PlanningTodoStore({ dbPath });
      initial.close();
      const legacy = new Database(dbPath);
      legacy.exec(`
        DROP TABLE planning_calendar_event_tag;
        DROP TABLE planning_reminder;
        DROP TABLE planning_calendar_event;
        DROP TABLE planning_group;
        DROP TABLE planning_tag;
        PRAGMA user_version = 2;
      `);
      legacy.close();

      const upgraded = new PlanningTodoStore({ dbPath });
      upgraded.close();
      const checked = new Database(dbPath);
      const tables = checked
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'planning_%'",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toContain(
        "planning_calendar_event",
      );
      expect(tables.map((row) => row.name)).toContain("planning_reminder");
      expect(checked.query("PRAGMA user_version").get()).toEqual({
        user_version: 3,
      });
      checked.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("creates, deduplicates assigned and unassigned titles, and records revisions", () =>
    withStore((store) => {
      const first = store.create({
        title: "  Ship   release  ",
        workspaceId: "11111111-1111-4111-8111-111111111111",
      });
      expect(first.deduplicated).toBeUndefined();
      expect(first.todo?.normalizedTitle).toBe("ship release");
      expect(first.todo?.priority).toBe("none");
      const duplicate = store.create({
        title: "ship release",
        workspaceId: "11111111-1111-4111-8111-111111111111",
      });
      expect(duplicate.deduplicated).toBe(true);
      expect(
        store.create({ title: "ship release" }).deduplicated,
      ).toBeUndefined();
      const todo = first.todo!;
      const updated = store.update({
        todoId: todo.id,
        expectedRevision: todo.revision,
        patch: { priority: "high" },
      });
      expect(updated.todo?.revision).toBe(todo.revision + 1);
      expect(
        store.list({ workspaceId: todo.workspaceId, view: "open" }).items,
      ).toHaveLength(1);
    }));

  test("enforces CAS and supports complete, soft delete, restore and purge", () =>
    withStore((store) => {
      const created = store.create({ title: "Verify backup" }).todo!;
      expect(() =>
        store.complete({ todoId: created.id, expectedRevision: 0 }),
      ).toThrow(PlanningTodoConflictError);
      const completed = store.complete({
        todoId: created.id,
        expectedRevision: created.revision,
      }).todo!;
      expect(completed.status).toBe("completed");
      const deleted = store.delete({
        todoId: created.id,
        expectedRevision: completed.revision,
      }).todo!;
      expect(deleted.deletedAt).toBeDefined();
      expect(store.list({ view: "trash" }).items[0]?.id).toBe(created.id);
      const restored = store.restore({
        todoId: created.id,
        expectedRevision: deleted.revision,
      }).todo!;
      expect(restored.deletedAt).toBeUndefined();
      store.purge({
        todoId: created.id,
        expectedRevision: restored.revision,
        confirmation: true,
      });
      expect(() => store.get(created.id)).toThrow();
    }));

  test("enforces relation-specific primary and mentioned link uniqueness", () =>
    withStore((store) => {
      const todo = store.create({ title: "Link me" }).todo!;
      store.link(todo.id, { threadId: "thread-a", relation: "primary" });
      expect(() =>
        store.link(todo.id, { threadId: "thread-a", relation: "primary" }),
      ).not.toThrow();
      store.link(todo.id, {
        threadId: "thread-b",
        messageId: "message-a",
        relation: "mentioned",
      });
      expect(() =>
        store.link(todo.id, {
          threadId: "thread-b",
          messageId: "message-a",
          relation: "mentioned",
        }),
      ).not.toThrow();
      expect(() =>
        store.link(todo.id, {
          threadId: "thread-b",
          relation: "primary",
          messageId: "message-a",
        }),
      ).toThrow();
      store.tombstoneThreadLinks("thread-a");
    }));

  test("clears and switches mutually exclusive deadlines atomically", () =>
    withStore((store) => {
      const created = store.create({
        title: "Deadline",
        dueDate: "2026-08-05",
        description: "keep",
      }).todo!;
      const precise = store.update({
        todoId: created.id,
        expectedRevision: created.revision,
        patch: { dueAt: 1_754_400_000_000, dueTimezone: "Asia/Shanghai" },
      }).todo!;
      expect(precise.dueDate).toBeUndefined();
      expect(precise.dueAt).toBe(1_754_400_000_000);
      expect(precise.dueTimezone).toBe("Asia/Shanghai");
      const cleared = store.update({
        todoId: created.id,
        expectedRevision: precise.revision,
        patch: { dueAt: null, description: null },
      }).todo!;
      expect(cleared.dueAt).toBeUndefined();
      expect(cleared.dueTimezone).toBeUndefined();
      expect(cleared.description).toBeUndefined();
    }));

  test("persists operation phases and keeps the constructor path", () =>
    withStore((store) => {
      expect(store.path).toContain("planning.sqlite");
      const reserved = store.reserveOperation({
        operationId: "operation-1",
        kind: "start",
        todoId: "todo-1",
        clientSubmissionId: "submission-1",
      });
      expect(reserved.phase).toBe("reserved");
      const advanced = store.advanceOperation("operation-1", {
        phase: "thread_created",
        threadId: "thread-1",
      });
      expect(advanced.threadId).toBe("thread-1");
      expect(store.getOperation("operation-1")).toMatchObject({
        phase: "thread_created",
        operationId: "operation-1",
        clientSubmissionId: "submission-1",
      });
    }));

  test("restores a project-removal snapshot and exposes recoverable operations", () =>
    withStore((store) => {
      const workspaceId = "11111111-1111-4111-8111-111111111111";
      const todo = store.create({
        title: "Keep project todo",
        workspaceId,
      }).todo!;
      const snapshot = store.snapshotWorkspaceTodos(workspaceId);
      store.reserveOperation({
        operationId: "project-operation",
        kind: "project_keep_history",
      });
      store.removeWorkspace(workspaceId, "keepHistory");
      expect(store.get(todo.id).workspaceId).toBeUndefined();
      expect(
        store.listRecoverableOperations(["project_keep_history"]),
      ).toHaveLength(1);

      store.restoreWorkspaceSnapshot(snapshot, "project-operation");
      expect(store.get(todo.id)).toMatchObject({
        workspaceId,
        title: todo.title,
        revision: todo.revision + 2,
      });
      store.advanceOperation("project-operation", {
        phase: "finalized",
        status: "compensated",
        compensation: "completed",
        recoverable: false,
      });
      expect(
        store.listRecoverableOperations(["project_keep_history"]),
      ).toHaveLength(0);
    }));

  test("跨连接同名创建走事务内去重而非裸 UNIQUE 错误(#647 P2-17)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-planning-concurrent-"));
    const dbPath = join(root, "planning.sqlite");
    let s1: PlanningTodoStore | undefined;
    let s2: PlanningTodoStore | undefined;
    try {
      s1 = new PlanningTodoStore({ dbPath, now: () => Date.now(), timezone: () => "Asia/Shanghai" });
      s2 = new PlanningTodoStore({ dbPath, now: () => Date.now(), timezone: () => "Asia/Shanghai" });
      // 注意：create 为同步方法，单线程下两次调用必然串行——本用例钉的是
      // “去重判定在 BEGIN IMMEDIATE 内 + 跨连接 WAL 可见性”，锁竞争路径未被行使
      const [r1, r2] = await Promise.all([
        s1.create({ title: "并发同名", workspaceId: "11111111-1111-4111-8111-111111111111" }),
        s2.create({ title: "并发同名", workspaceId: "11111111-1111-4111-8111-111111111111" }),
      ]);
      // 恰有一条真实创建、一条去重返回，绝不抛 SQLITE UNIQUE
      expect([r1.deduplicated, r2.deduplicated].filter(Boolean)).toHaveLength(1);
    } finally {
      try { s1?.close(); } catch { /* 已关闭 */ }
      try { s2?.close(); } catch { /* 已关闭 */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("isTrustedPrimarySubmission 信任判定两路(#647 P2-14)", () =>
    withStore((store) => {
      const todo = store.create({ title: "信任判定" }).todo!;
      const operation = store.reserveOperation({
        operationId: "op-trust-check",
        kind: "start",
        todoId: todo.id,
        clientSubmissionId: "sub-trust",
      });
      store.advanceOperation(operation.operationId, { phase: "thread_created", status: "running", threadId: "thread-trust" });

      const matched = store.isTrustedPrimarySubmission({
        operationId: operation.operationId,
        clientSubmissionId: "sub-trust",
        threadId: "thread-trust",
      });
      expect(matched).toBe(true);

      const mismatched = store.isTrustedPrimarySubmission({
        operationId: operation.operationId,
        clientSubmissionId: "sub-other",
        threadId: "thread-trust",
      });
      expect(mismatched).toBe(false);
    }));

  test("migrate 幂等创建 operation_id 查询索引且查询走该索引(#647 P2-14)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-planning-index-"));
    const dbPath = join(root, "planning.sqlite");
    try {
      const store = new PlanningTodoStore({ dbPath });
      store.close();
      const checked = new Database(dbPath);
      const indexes = checked
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name='planning_todo_event_operation'")
        .all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
      // 钉住查询计划：直查必须命中新索引（防未来查询改写静默退化为全表扫）
      const plan = checked
        .query("EXPLAIN QUERY PLAN SELECT payload_json FROM planning_todo_event WHERE operation_id = ? AND operation IN ('start','continue') ORDER BY seq DESC")
        .all("op-any") as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes("planning_todo_event_operation"))).toBe(true);
      checked.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
