import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PlanningTodoStore } from "./planning-todo-store";
import {
  PlanningCalendarConflictError,
  PlanningCalendarStore,
} from "./planning-calendar-store";

function withStores(
  run: (
    todoStore: PlanningTodoStore,
    calendar: PlanningCalendarStore,
    setNow: (value: number) => void,
  ) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "lume-calendar-test-"));
  const dbPath = join(root, "planning.sqlite");
  let now = 1_800_000_000_000;
  const todoStore = new PlanningTodoStore({ dbPath, now: () => now });
  const calendar = new PlanningCalendarStore({ dbPath, now: () => now });
  try {
    run(todoStore, calendar, (value) => {
      now = value;
    });
  } finally {
    calendar.close();
    todoStore.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("PlanningCalendarStore", () => {
  test("persists events, groups, tags, Todo links and revision CAS", () =>
    withStores((todos, calendar) => {
      const todo = todos.create({ title: "准备评审" }).todo!;
      const group = calendar.createGroup({ scope: "calendar", name: "工作" });
      const tag = calendar.createTag({ name: "重要" });
      const event = calendar.createEvent({
        title: "产品评审",
        notes: "带上方案",
        startAt: 1_800_000_060_000,
        endAt: 1_800_000_420_000,
        groupId: group.id,
        tagIds: [tag.id],
        todoId: todo.id,
      });
      expect(
        calendar.listEvents({
          from: event.startAt - 1,
          to: event.endAt! + 1,
        })[0],
      ).toMatchObject({
        id: event.id,
        groupId: group.id,
        todoId: todo.id,
        revision: 1,
      });
      expect(calendar.getEvent(event.id).tags.map((item) => item.id)).toEqual([
        tag.id,
      ]);
      expect(() =>
        calendar.updateEvent({
          eventId: event.id,
          expectedRevision: 2,
          patch: { title: "旧写入" },
        }),
      ).toThrow(PlanningCalendarConflictError);
      expect(
        calendar.updateEvent({
          eventId: event.id,
          expectedRevision: 1,
          patch: { title: "评审更新" },
        }),
      ).toMatchObject({ title: "评审更新", revision: 2 });
    }));

  test("claims each reminder once and reclaims it after snooze", () =>
    withStores((_todos, calendar, setNow) => {
      const event = calendar.createEvent({
        title: "站会",
        startAt: 1_800_000_600_000,
        reminderTimes: [1_800_000_000_000],
      });
      const first = calendar.claimDueReminders();
      expect(first).toHaveLength(1);
      expect(calendar.claimDueReminders()).toHaveLength(0);
      calendar.snoozeReminder({ reminderId: first[0]!.id, minutes: 5 });
      setNow(1_800_000_300_001);
      expect(calendar.claimDueReminders()).toMatchObject([
        { targetId: event.id, targetTitle: "站会" },
      ]);
      calendar.acknowledgeReminder(first[0]!.id);
      expect(calendar.listActiveReminders()).toHaveLength(0);
    }));

  test("synchronizes exact Todo due times and completes pending reminders", () =>
    withStores((todos, calendar, setNow) => {
      const todo = todos.create({
        title: "交付",
        dueAt: 1_800_000_060_000,
        dueTimezone: "Asia/Shanghai",
      }).todo!;
      const manual = calendar.createReminder({
        targetType: "todo",
        targetId: todo.id,
        triggerAt: 1_800_000_600_000,
      });
      expect(
        calendar.listReminders("todo", todo.id).map((item) => item.id),
      ).toContain(manual.id);
      setNow(todo.dueAt! + 1);
      expect(calendar.listActiveReminders()).toMatchObject([
        { targetType: "todo", targetId: todo.id, origin: "todo_due_at" },
      ]);
      todos.complete({ todoId: todo.id, expectedRevision: todo.revision });
      expect(calendar.listActiveReminders()).toHaveLength(0);
    }));
});
