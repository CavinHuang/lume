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

  test("synchronizes exact Todo due times; completes auto due reminders, keeps manual ones", () =>
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
      // #647 P1-5：complete 只收口自动跟随的 due 提醒，手动提醒保留意图
      todos.complete({ todoId: todo.id, expectedRevision: todo.revision });
      const reminders = calendar.listReminders("todo", todo.id);
      expect(reminders.find((item) => item.origin === "todo_due_at")?.status).toBe("completed");
      expect(reminders.find((item) => item.origin === "manual")?.status).toBe("pending");
    }));

  test("snoozed 的 due 提醒在 dueAt 变更后跟随新时间且不双触发(#647 P1-4)", () =>
    withStores((todos, calendar, setNow) => {
      const todo = todos.create({
        title: "跟随",
        dueAt: 1_800_000_100_000,
        dueTimezone: "Asia/Shanghai",
      }).todo!;
      const auto = calendar
        .listReminders("todo", todo.id)
        .find((item) => item.origin === "todo_due_at");
      expect(auto).toBeDefined();

      // 到期前 snooze，随后改期：旧提醒必须跟随新 dueAt，而不是旧时间弹一次+新时间再弹一次
      calendar.snoozeReminder({ reminderId: auto!.id, minutes: 5 });
      todos.update({
        todoId: todo.id,
        expectedRevision: todo.revision,
        patch: { dueAt: 1_800_000_500_000 },
      });

      const reminders = calendar.listReminders("todo", todo.id);
      expect(reminders.filter((item) => item.origin === "todo_due_at")).toHaveLength(1);
      const followUp = reminders.find((item) => item.origin === "todo_due_at")!;
      expect(followUp.triggerAt).toBe(1_800_000_500_000);
      expect(followUp.snoozedUntil ?? null).toBeNull();

      // 新到期时间只触发一次；旧 snooze 时间点不再触发
      setNow(1_800_000_499_999);
      expect(calendar.claimDueReminders()).toHaveLength(0);
      setNow(1_800_000_500_001);
      expect(calendar.claimDueReminders()).toMatchObject([
        { targetId: todo.id, origin: "todo_due_at" },
      ]);
      expect(calendar.claimDueReminders()).toHaveLength(0);
    }));

  test("complete 后 reopen 重建 due 提醒(#647 P1-5)", () =>
    withStores((todos, calendar, setNow) => {
      const todo = todos.create({
        title: "误点完成",
        dueAt: 1_800_000_300_000,
        dueTimezone: "Asia/Shanghai",
      }).todo!;
      todos.complete({ todoId: todo.id, expectedRevision: todo.revision });
      setNow(1_800_000_200_000);
      expect(
        calendar.listReminders("todo", todo.id).filter((item) => item.origin === "todo_due_at" && item.status === "pending"),
      ).toHaveLength(0);

      const reopened = todos.reopen({ todoId: todo.id, expectedRevision: todo.revision + 1 });
      expect(reopened.todo?.status).toBe("open");
      const revived = calendar
        .listReminders("todo", todo.id)
        .filter((item) => item.origin === "todo_due_at" && item.status === "pending");
      expect(revived).toHaveLength(1);
      expect(revived[0]!.triggerAt).toBe(1_800_000_300_000);
    }));

  test("清除 dueAt 时连坐 snoozed 的自动提醒（不留旧时间僵尸）(#647 P1-4)", () =>
    withStores((todos, calendar) => {
      const todo = todos.create({
        title: "清空到期",
        dueAt: 1_800_000_100_000,
        dueTimezone: "Asia/Shanghai",
      }).todo!;
      const auto = calendar
        .listReminders("todo", todo.id)
        .find((item) => item.origin === "todo_due_at");
      expect(auto).toBeDefined();

      calendar.snoozeReminder({ reminderId: auto!.id, minutes: 5 });
      todos.update({
        todoId: todo.id,
        expectedRevision: todo.revision,
        patch: { dueAt: null },
      });

      expect(
        calendar.listReminders("todo", todo.id).filter(
          (item) => item.origin === "todo_due_at" && item.status === "pending",
        ),
      ).toHaveLength(0);
    }));

  test("delete→restore 只复活自动提醒，手动提醒不回（有意取舍，#647 P1-5）", () =>
    withStores((todos, calendar) => {
      const todo = todos.create({
        title: "回收站往返",
        dueAt: 1_800_000_400_000,
        dueTimezone: "Asia/Shanghai",
      }).todo!;
      calendar.createReminder({
        targetType: "todo",
        targetId: todo.id,
        triggerAt: 1_800_000_600_000,
      });

      const deleted = todos.delete({ todoId: todo.id, expectedRevision: todo.revision });
      expect(
        calendar.listReminders("todo", todo.id).filter((item) => item.status === "pending"),
      ).toHaveLength(0);

      todos.restore({ todoId: todo.id, expectedRevision: deleted.todo!.revision });
      const pendingAfterRestore = calendar
        .listReminders("todo", todo.id)
        .filter((item) => item.status === "pending");
      // 自动提醒重建；手动提醒保持 completed——completed 状态无法区分收口来源，
      // 复活需额外记账，属有意取舍（见 planning-todo-store.ts #mutate 注释）
      expect(pendingAfterRestore.map((item) => item.origin)).toEqual(["todo_due_at"]);
    }));
});
