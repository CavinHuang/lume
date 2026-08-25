import { randomUUID } from "node:crypto";
import type {
  ActivePlanningReminder,
  PlanningCalendarEvent,
  PlanningCalendarEventCreateInput,
  PlanningCalendarEventListInput,
  PlanningCalendarEventUpdateInput,
  PlanningChangeResource,
  PlanningGroup,
  PlanningGroupCreateInput,
  PlanningGroupScope,
  PlanningGroupUpdateInput,
  PlanningReminder,
  PlanningReminderCreateInput,
  PlanningReminderSnoozeInput,
  PlanningReminderTargetType,
  PlanningTag,
  PlanningTagCreateInput,
  PlanningTagUpdateInput,
  PlanningTodoChangeEvent,
} from "@lume/shared";
import { normalizePlanningTodoTitle } from "@lume/shared";
import { openSqlite, type SqliteDatabase } from "../infra/open-sqlite";
import { getPlanningTodoStore } from "./planning-todo-store";

interface EventRow {
  id: string;
  title: string;
  notes: string | null;
  start_at: number;
  end_at: number | null;
  all_day: number;
  group_id: string | null;
  workspace_id: string | null;
  todo_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}
interface GroupRow {
  id: string;
  scope: PlanningGroupScope;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}
interface TagRow {
  id: string;
  name: string;
  color: string | null;
  created_at: number;
  updated_at: number;
}
interface ReminderRow {
  id: string;
  target_type: PlanningReminderTargetType;
  target_id: string;
  trigger_at: number;
  snoozed_until: number | null;
  status: PlanningReminder["status"];
  origin: PlanningReminder["origin"];
  acknowledged_at: number | null;
  last_notified_at: number | null;
  created_at: number;
  updated_at: number;
}

export class PlanningCalendarConflictError extends Error {
  readonly code = "planning_calendar_conflict";
  constructor(readonly latest: PlanningCalendarEvent) {
    super("日程已被其他窗口修改，请重新加载后再试");
  }
}

export class PlanningCalendarStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => number;
  readonly #onChange?: (event: PlanningTodoChangeEvent) => void;

  constructor(input: {
    dbPath: string;
    now?: () => number;
    onChange?: (event: PlanningTodoChangeEvent) => void;
  }) {
    this.#db = openSqlite(input.dbPath);
    this.#now = input.now ?? Date.now;
    this.#onChange = input.onChange;
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
  }

  listEvents(
    input: PlanningCalendarEventListInput = {},
  ): PlanningCalendarEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.from !== undefined) {
      where.push("COALESCE(end_at,start_at) >= ?");
      params.push(input.from);
    }
    if (input.to !== undefined) {
      where.push("start_at <= ?");
      params.push(input.to);
    }
    if (input.scope === "current") {
      where.push("workspace_id = ?");
      params.push(input.workspaceId ?? "");
    }
    if (input.scope === "unassigned") where.push("workspace_id IS NULL");
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 500);
    params.push(limit);
    const rows = this.#db
      .prepare(
        `SELECT * FROM planning_calendar_event${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY start_at,id LIMIT ?`,
      )
      .all(...params) as EventRow[];
    return rows.map((row) => this.#eventFromRow(row));
  }

  getEvent(eventId: string): PlanningCalendarEvent {
    const row = this.#db
      .prepare("SELECT * FROM planning_calendar_event WHERE id = ?")
      .get(eventId) as EventRow | undefined;
    if (!row) throw new Error("日程不存在");
    return this.#eventFromRow(row);
  }

  createEvent(input: PlanningCalendarEventCreateInput): PlanningCalendarEvent {
    const title = requiredText(input.title, "日程标题", 500);
    validateTimes(input.startAt, input.endAt);
    this.#assertRelations(input.groupId, input.todoId);
    const tagIds = this.#validateTagIds(input.tagIds ?? []);
    const reminderTimes = validateReminderTimes(input.reminderTimes ?? []);
    const now = this.#now();
    const id = randomUUID();
    let seq = 0;
    this.#transaction(() => {
      this.#db
        .prepare(
          "INSERT INTO planning_calendar_event (id,title,notes,start_at,end_at,all_day,group_id,workspace_id,todo_id,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)",
        )
        .run(
          id,
          title,
          optionalText(input.notes),
          input.startAt,
          input.endAt ?? null,
          input.allDay ? 1 : 0,
          input.groupId ?? null,
          input.workspaceId ?? null,
          input.todoId ?? null,
          now,
          now,
        );
      this.#replaceEventTags(id, tagIds);
      for (const triggerAt of reminderTimes)
        this.#insertReminder(
          { targetType: "calendar_event", targetId: id, triggerAt },
          "manual",
          now,
        );
      seq = this.#audit(
        "calendar_event_created",
        ["calendar_events", "reminders"],
        { eventId: id },
        now,
      );
    });
    const event = this.getEvent(id);
    this.#publish(
      seq,
      ["calendar_events", "reminders"],
      id,
      event.workspaceId,
      now,
    );
    return event;
  }

  updateEvent(input: PlanningCalendarEventUpdateInput): PlanningCalendarEvent {
    const before = this.getEvent(input.eventId);
    if (before.revision !== input.expectedRevision)
      throw new PlanningCalendarConflictError(before);
    const patch = input.patch;
    const next = {
      ...before,
      title:
        patch.title === undefined
          ? before.title
          : requiredText(patch.title, "日程标题", 500),
      notes:
        patch.notes === undefined
          ? before.notes
          : (optionalText(patch.notes ?? undefined) ?? undefined),
      startAt: patch.startAt ?? before.startAt,
      endAt:
        patch.endAt === undefined ? before.endAt : (patch.endAt ?? undefined),
      allDay: patch.allDay ?? before.allDay,
      groupId:
        patch.groupId === undefined
          ? before.groupId
          : (patch.groupId ?? undefined),
      workspaceId:
        patch.workspaceId === undefined
          ? before.workspaceId
          : (patch.workspaceId ?? undefined),
      todoId:
        patch.todoId === undefined
          ? before.todoId
          : (patch.todoId ?? undefined),
      revision: before.revision + 1,
      updatedAt: this.#now(),
    };
    validateTimes(next.startAt, next.endAt);
    this.#assertRelations(next.groupId, next.todoId);
    const tagIds =
      patch.tagIds === undefined
        ? undefined
        : this.#validateTagIds(patch.tagIds);
    let seq = 0;
    this.#transaction(() => {
      const changed = this.#db
        .prepare(
          "UPDATE planning_calendar_event SET title=?,notes=?,start_at=?,end_at=?,all_day=?,group_id=?,workspace_id=?,todo_id=?,revision=?,updated_at=? WHERE id=? AND revision=?",
        )
        .run(
          next.title,
          next.notes ?? null,
          next.startAt,
          next.endAt ?? null,
          next.allDay ? 1 : 0,
          next.groupId ?? null,
          next.workspaceId ?? null,
          next.todoId ?? null,
          next.revision,
          next.updatedAt,
          next.id,
          input.expectedRevision,
        ) as { changes?: number };
      if (changed.changes === 0)
        throw new PlanningCalendarConflictError(this.getEvent(input.eventId));
      if (tagIds) this.#replaceEventTags(next.id, tagIds);
      seq = this.#audit(
        "calendar_event_updated",
        ["calendar_events"],
        { before, after: next },
        next.updatedAt,
      );
    });
    const event = this.getEvent(next.id);
    this.#publish(
      seq,
      ["calendar_events"],
      event.id,
      event.workspaceId,
      event.updatedAt,
    );
    return event;
  }

  deleteEvent(
    eventId: string,
    expectedRevision: number,
  ): PlanningCalendarEvent {
    const before = this.getEvent(eventId);
    if (before.revision !== expectedRevision)
      throw new PlanningCalendarConflictError(before);
    const now = this.#now();
    let seq = 0;
    this.#transaction(() => {
      this.#db
        .prepare(
          "DELETE FROM planning_reminder WHERE target_type='calendar_event' AND target_id=?",
        )
        .run(eventId);
      this.#db
        .prepare(
          "DELETE FROM planning_calendar_event WHERE id=? AND revision=?",
        )
        .run(eventId, expectedRevision);
      seq = this.#audit(
        "calendar_event_deleted",
        ["calendar_events", "reminders"],
        { before },
        now,
      );
    });
    this.#publish(
      seq,
      ["calendar_events", "reminders"],
      eventId,
      before.workspaceId,
      now,
    );
    return before;
  }

  listGroups(scope: PlanningGroupScope): PlanningGroup[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM planning_group WHERE scope=? ORDER BY sort_order,name",
        )
        .all(scope) as GroupRow[]
    ).map(groupFromRow);
  }
  createGroup(input: PlanningGroupCreateInput): PlanningGroup {
    const now = this.#now();
    const id = randomUUID();
    const name = requiredText(input.name, "分组名称", 100);
    this.#changed(
      "group_created",
      [input.scope === "calendar" ? "calendar_groups" : "todo_groups"],
      { groupId: id },
      now,
      () =>
        this.#db
          .prepare(
            "INSERT INTO planning_group (id,scope,name,normalized_name,color,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            input.scope,
            name,
            normalizePlanningTodoTitle(name),
            optionalText(input.color),
            input.sortOrder ?? 0,
            now,
            now,
          ),
    );
    return this.listGroups(input.scope).find((item) => item.id === id)!;
  }
  updateGroup(input: PlanningGroupUpdateInput): PlanningGroup {
    const old = this.listGroups(input.scope).find(
      (item) => item.id === input.groupId,
    );
    if (!old) throw new Error("分组不存在");
    const now = this.#now();
    const name =
      input.name === undefined
        ? old.name
        : requiredText(input.name, "分组名称", 100);
    this.#changed(
      "group_updated",
      [
        input.scope === "calendar" ? "calendar_groups" : "todo_groups",
        input.scope === "calendar" ? "calendar_events" : "todos",
      ],
      { groupId: input.groupId },
      now,
      () =>
        this.#db
          .prepare(
            "UPDATE planning_group SET name=?,normalized_name=?,color=?,sort_order=?,updated_at=? WHERE id=? AND scope=?",
          )
          .run(
            name,
            normalizePlanningTodoTitle(name),
            input.color === undefined
              ? (old.color ?? null)
              : optionalText(input.color ?? undefined),
            input.sortOrder ?? old.sortOrder,
            now,
            input.groupId,
            input.scope,
          ),
    );
    return this.listGroups(input.scope).find(
      (item) => item.id === input.groupId,
    )!;
  }
  deleteGroup(scope: PlanningGroupScope, groupId: string): void {
    const now = this.#now();
    this.#changed(
      "group_deleted",
      [
        scope === "calendar" ? "calendar_groups" : "todo_groups",
        scope === "calendar" ? "calendar_events" : "todos",
      ],
      { groupId },
      now,
      () => {
        const result = this.#db
          .prepare("DELETE FROM planning_group WHERE id=? AND scope=?")
          .run(groupId, scope) as { changes?: number };
        if (!result.changes) throw new Error("分组不存在");
      },
    );
  }

  listTags(): PlanningTag[] {
    return (
      this.#db
        .prepare("SELECT * FROM planning_tag ORDER BY name")
        .all() as TagRow[]
    ).map(tagFromRow);
  }
  createTag(input: PlanningTagCreateInput): PlanningTag {
    const now = this.#now();
    const id = randomUUID();
    const name = requiredText(input.name, "标签名称", 100);
    this.#changed("tag_created", ["tags"], { tagId: id }, now, () =>
      this.#db
        .prepare(
          "INSERT INTO planning_tag (id,name,normalized_name,color,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          id,
          name,
          normalizePlanningTodoTitle(name),
          optionalText(input.color),
          now,
          now,
        ),
    );
    return this.listTags().find((item) => item.id === id)!;
  }
  updateTag(input: PlanningTagUpdateInput): PlanningTag {
    const old = this.listTags().find((item) => item.id === input.tagId);
    if (!old) throw new Error("标签不存在");
    const now = this.#now();
    const name =
      input.name === undefined
        ? old.name
        : requiredText(input.name, "标签名称", 100);
    this.#changed(
      "tag_updated",
      ["tags", "calendar_events"],
      { tagId: input.tagId },
      now,
      () =>
        this.#db
          .prepare(
            "UPDATE planning_tag SET name=?,normalized_name=?,color=?,updated_at=? WHERE id=?",
          )
          .run(
            name,
            normalizePlanningTodoTitle(name),
            input.color === undefined
              ? (old.color ?? null)
              : optionalText(input.color ?? undefined),
            now,
            input.tagId,
          ),
    );
    return this.listTags().find((item) => item.id === input.tagId)!;
  }
  deleteTag(tagId: string): void {
    const now = this.#now();
    this.#changed(
      "tag_deleted",
      ["tags", "calendar_events"],
      { tagId },
      now,
      () => {
        const result = this.#db
          .prepare("DELETE FROM planning_tag WHERE id=?")
          .run(tagId) as { changes?: number };
        if (!result.changes) throw new Error("标签不存在");
      },
    );
  }

  createReminder(input: PlanningReminderCreateInput): PlanningReminder {
    validateReminderTimes([input.triggerAt]);
    this.#assertReminderTarget(input.targetType, input.targetId);
    const now = this.#now();
    let reminder: PlanningReminder | undefined;
    this.#changed(
      "reminder_created",
      ["reminders"],
      { targetType: input.targetType, targetId: input.targetId },
      now,
      () => {
        reminder = this.#insertReminder(input, "manual", now);
      },
    );
    return reminder!;
  }
  listReminders(
    targetType: PlanningReminderTargetType,
    targetId: string,
  ): PlanningReminder[] {
    this.#assertReminderTarget(targetType, targetId);
    return this.#targetReminders(targetType, targetId);
  }
  deleteReminder(reminderId: string): void {
    const now = this.#now();
    this.#changed(
      "reminder_deleted",
      ["reminders"],
      { reminderId },
      now,
      () => {
        const result = this.#db
          .prepare("DELETE FROM planning_reminder WHERE id=?")
          .run(reminderId) as { changes?: number };
        if (!result.changes) throw new Error("提醒不存在");
      },
    );
  }
  acknowledgeReminder(reminderId: string): PlanningReminder {
    const now = this.#now();
    this.#changed(
      "reminder_acknowledged",
      ["reminders"],
      { reminderId },
      now,
      () => {
        const result = this.#db
          .prepare(
            "UPDATE planning_reminder SET status='acknowledged',acknowledged_at=?,updated_at=? WHERE id=? AND status='pending'",
          )
          .run(now, now, reminderId) as { changes?: number };
        if (!result.changes) throw new Error("提醒不存在或已处理");
      },
    );
    return this.#getReminder(reminderId)!;
  }
  snoozeReminder(input: PlanningReminderSnoozeInput): PlanningReminder {
    if (
      !Number.isInteger(input.minutes) ||
      input.minutes < 1 ||
      input.minutes > 10_080
    )
      throw new Error("推迟分钟数必须在 1 到 10080 之间");
    const now = this.#now();
    this.#changed(
      "reminder_snoozed",
      ["reminders"],
      { reminderId: input.reminderId },
      now,
      () => {
        const result = this.#db
          .prepare(
            "UPDATE planning_reminder SET snoozed_until=?,last_notified_at=NULL,origin='manual',updated_at=? WHERE id=? AND status='pending'",
          )
          .run(now + input.minutes * 60_000, now, input.reminderId) as {
          changes?: number;
        };
        if (!result.changes) throw new Error("提醒不存在或已处理");
      },
    );
    return this.#getReminder(input.reminderId)!;
  }
  listActiveReminders(now = this.#now()): ActivePlanningReminder[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM planning_reminder WHERE status='pending' AND COALESCE(snoozed_until,trigger_at)<=? ORDER BY COALESCE(snoozed_until,trigger_at)",
      )
      .all(now) as ReminderRow[];
    return rows.flatMap((row) => {
      const target = this.#targetSummary(row.target_type, row.target_id);
      return target ? [{ ...reminderFromRow(row), ...target }] : [];
    });
  }
  claimDueReminders(now = this.#now()): ActivePlanningReminder[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM planning_reminder WHERE status='pending' AND COALESCE(snoozed_until,trigger_at)<=? AND last_notified_at IS NULL ORDER BY COALESCE(snoozed_until,trigger_at)",
      )
      .all(now) as ReminderRow[];
    if (!rows.length) return [];
    const result: ActivePlanningReminder[] = [];
    this.#transaction(() => {
      for (const row of rows) {
        this.#db
          .prepare(
            "UPDATE planning_reminder SET last_notified_at=?,updated_at=? WHERE id=? AND last_notified_at IS NULL",
          )
          .run(now, now, row.id);
        const target = this.#targetSummary(row.target_type, row.target_id);
        if (target)
          result.push({
            ...reminderFromRow({
              ...row,
              last_notified_at: now,
              updated_at: now,
            }),
            ...target,
          });
      }
      this.#audit(
        "reminders_claimed",
        ["reminders"],
        { reminderIds: result.map((item) => item.id) },
        now,
      );
    });
    return result;
  }

  close(): void {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.#db.close();
  }

  #eventFromRow(row: EventRow): PlanningCalendarEvent {
    return {
      id: row.id,
      title: row.title,
      ...(row.notes ? { notes: row.notes } : {}),
      startAt: row.start_at,
      ...(row.end_at !== null ? { endAt: row.end_at } : {}),
      allDay: row.all_day === 1,
      ...(row.group_id
        ? {
            groupId: row.group_id,
            group: this.listGroups("calendar").find(
              (item) => item.id === row.group_id,
            ),
          }
        : {}),
      tags: this.#eventTags(row.id),
      reminders: this.#targetReminders("calendar_event", row.id),
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      ...(row.todo_id ? { todoId: row.todo_id } : {}),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  #eventTags(eventId: string): PlanningTag[] {
    return (
      this.#db
        .prepare(
          "SELECT t.* FROM planning_tag t JOIN planning_calendar_event_tag et ON et.tag_id=t.id WHERE et.event_id=? ORDER BY t.name",
        )
        .all(eventId) as TagRow[]
    ).map(tagFromRow);
  }
  #targetReminders(
    type: PlanningReminderTargetType,
    id: string,
  ): PlanningReminder[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM planning_reminder WHERE target_type=? AND target_id=? ORDER BY COALESCE(snoozed_until,trigger_at)",
        )
        .all(type, id) as ReminderRow[]
    ).map(reminderFromRow);
  }
  #replaceEventTags(eventId: string, tagIds: string[]): void {
    this.#db
      .prepare("DELETE FROM planning_calendar_event_tag WHERE event_id=?")
      .run(eventId);
    for (const tagId of tagIds)
      this.#db
        .prepare(
          "INSERT INTO planning_calendar_event_tag (event_id,tag_id) VALUES (?,?)",
        )
        .run(eventId, tagId);
  }
  #validateTagIds(tagIds: string[]): string[] {
    const unique = [...new Set(tagIds)];
    for (const id of unique)
      if (!this.#db.prepare("SELECT id FROM planning_tag WHERE id=?").get(id))
        throw new Error("标签不存在");
    return unique;
  }
  #assertRelations(groupId?: string, todoId?: string): void {
    if (
      groupId &&
      !this.#db
        .prepare(
          "SELECT id FROM planning_group WHERE id=? AND scope='calendar'",
        )
        .get(groupId)
    )
      throw new Error("日程分组不存在");
    if (
      todoId &&
      !this.#db
        .prepare(
          "SELECT id FROM planning_todo WHERE id=? AND deleted_at IS NULL",
        )
        .get(todoId)
    )
      throw new Error("关联 Todo 不存在");
  }
  #assertReminderTarget(type: PlanningReminderTargetType, id: string): void {
    const table = type === "todo" ? "planning_todo" : "planning_calendar_event";
    if (!this.#db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id))
      throw new Error("提醒目标不存在");
  }
  #insertReminder(
    input: PlanningReminderCreateInput,
    origin: PlanningReminder["origin"],
    now: number,
  ): PlanningReminder {
    const id = randomUUID();
    this.#db
      .prepare(
        "INSERT INTO planning_reminder (id,target_type,target_id,trigger_at,status,origin,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?)",
      )
      .run(
        id,
        input.targetType,
        input.targetId,
        input.triggerAt,
        origin,
        now,
        now,
      );
    return this.#getReminder(id)!;
  }
  #getReminder(id: string): PlanningReminder | undefined {
    const row = this.#db
      .prepare("SELECT * FROM planning_reminder WHERE id=?")
      .get(id) as ReminderRow | undefined;
    return row ? reminderFromRow(row) : undefined;
  }
  #targetSummary(
    type: PlanningReminderTargetType,
    id: string,
  ):
    | Pick<
        ActivePlanningReminder,
        "targetTitle" | "workspaceId" | "group" | "tags"
      >
    | undefined {
    if (type === "calendar_event") {
      try {
        const event = this.getEvent(id);
        return {
          targetTitle: event.title,
          ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
          ...(event.group ? { group: event.group } : {}),
          tags: event.tags,
        };
      } catch {
        return undefined;
      }
    }
    const todo = this.#db
      .prepare(
        "SELECT title,workspace_id FROM planning_todo WHERE id=? AND deleted_at IS NULL",
      )
      .get(id) as { title: string; workspace_id: string | null } | undefined;
    return todo
      ? {
          targetTitle: todo.title,
          ...(todo.workspace_id ? { workspaceId: todo.workspace_id } : {}),
          tags: [],
        }
      : undefined;
  }
  #transaction(run: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* preserve error */
      }
      throw error;
    }
  }
  #audit(
    operation: string,
    resources: PlanningChangeResource[],
    payload: unknown,
    now: number,
  ): number {
    this.#db
      .prepare(
        "INSERT INTO planning_todo_event (todo_id,operation,phase,payload_json,created_at) VALUES (NULL,?,'finalized',?,?)",
      )
      .run(operation, JSON.stringify({ resources, payload }), now);
    return (
      this.#db
        .prepare(
          "SELECT seq FROM planning_todo_event WHERE rowid=last_insert_rowid()",
        )
        .get() as { seq: number }
    ).seq;
  }
  #changed(
    operation: string,
    resources: PlanningChangeResource[],
    payload: unknown,
    now: number,
    run: () => void,
  ): void {
    let seq = 0;
    this.#transaction(() => {
      run();
      seq = this.#audit(operation, resources, payload, now);
    });
    this.#publish(seq, resources, undefined, undefined, now);
  }
  #publish(
    eventSeq: number,
    resources: PlanningChangeResource[],
    todoId: string | undefined,
    workspaceId: string | undefined,
    updatedAt: number,
  ): void {
    queueMicrotask(() =>
      this.#onChange?.({
        eventSeq,
        ...(todoId ? { todoId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        resources,
        updatedAt,
      }),
    );
  }
}

function requiredText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max)
    throw new Error(`${label}不能为空且不能超过 ${max} 字`);
  return text;
}
function optionalText(value?: string): string | null {
  return value?.trim() || null;
}
function validateTimes(startAt: number, endAt?: number): void {
  if (!Number.isFinite(startAt) || startAt <= 0)
    throw new Error("startAt 必须是有效时间戳");
  if (endAt !== undefined && (!Number.isFinite(endAt) || endAt < startAt))
    throw new Error("endAt 不能早于 startAt");
}
function validateReminderTimes(values: number[]): number[] {
  const unique = [...new Set(values)];
  for (const value of unique)
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("提醒时间必须是有效时间戳");
  return unique;
}
function groupFromRow(row: GroupRow): PlanningGroup {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    ...(row.color ? { color: row.color } : {}),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function tagFromRow(row: TagRow): PlanningTag {
  return {
    id: row.id,
    name: row.name,
    ...(row.color ? { color: row.color } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function reminderFromRow(row: ReminderRow): PlanningReminder {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    triggerAt: row.trigger_at,
    ...(row.snoozed_until !== null ? { snoozedUntil: row.snoozed_until } : {}),
    status: row.status,
    origin: row.origin,
    ...(row.acknowledged_at !== null
      ? { acknowledgedAt: row.acknowledged_at }
      : {}),
    ...(row.last_notified_at !== null
      ? { lastNotifiedAt: row.last_notified_at }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

let singleton: PlanningCalendarStore | undefined;
export function getPlanningCalendarStore(input?: {
  onChange?: (event: PlanningTodoChangeEvent) => void;
}): PlanningCalendarStore {
  if (!singleton)
    singleton = new PlanningCalendarStore({
      dbPath: getPlanningTodoStore().path,
      onChange: input?.onChange,
    });
  return singleton;
}
export function closePlanningCalendarStore(): void {
  singleton?.close();
  singleton = undefined;
}
export function resetPlanningCalendarStoreForTests(): void {
  closePlanningCalendarStore();
}
