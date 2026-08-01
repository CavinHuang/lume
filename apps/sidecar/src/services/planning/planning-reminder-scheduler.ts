import { PLANNING_TODO_IPC_CHANNELS } from "@lume/shared";
import type { NotificationWriter } from "../../rpc/types";
import { writeLogRecord } from "../infra/logger";
import { getPlanningCalendarStore } from "./planning-calendar-store";

const POLL_INTERVAL_MS = 30_000;
let timer: ReturnType<typeof setInterval> | undefined;
let checking = false;

export function startPlanningReminderScheduler(
  writeNotification: NotificationWriter,
): void {
  if (timer) return;
  const check = (): void => {
    if (checking) return;
    checking = true;
    try {
      const reminders = getPlanningCalendarStore().claimDueReminders();
      if (reminders.length > 0)
        writeNotification(PLANNING_TODO_IPC_CHANNELS.REMINDER_DUE, reminders);
    } catch (error) {
      writeLogRecord({
        level: "warn",
        context: "planning.reminder",
        event: "planning.reminder_poll_failed",
        message: "planning reminder poll failed",
        data: { error },
      });
    } finally {
      checking = false;
    }
  };
  check();
  timer = setInterval(check, POLL_INTERVAL_MS);
}

export function stopPlanningReminderScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
