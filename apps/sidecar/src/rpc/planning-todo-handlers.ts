import {
  PLANNING_TODO_IPC_CHANNELS,
  type PlanningCalendarEventCreateInput,
  type PlanningCalendarEventUpdateInput,
  type PlanningGroupCreateInput,
  type PlanningGroupUpdateInput,
  type PlanningReminderCreateInput,
  type PlanningReminderSnoozeInput,
  type PlanningTagCreateInput,
  type PlanningTagUpdateInput,
  type PlanningTodoCreateInput,
  type PlanningTodoPurgeInput,
  type PlanningTodoUpdateInput,
} from "@lume/shared";
import { getPlanningTodoStore } from "../services/planning/planning-todo-store";
import {
  planningCalendarEventCreateInputSchema,
  planningCalendarEventDeleteInputSchema,
  planningCalendarEventIdSchema,
  planningCalendarEventListInputSchema,
  planningCalendarEventUpdateInputSchema,
  planningEntityDeleteInputSchema,
  planningGroupCreateInputSchema,
  planningGroupListInputSchema,
  planningGroupUpdateInputSchema,
  planningReminderCreateInputSchema,
  planningReminderIdSchema,
  planningReminderSnoozeInputSchema,
  planningReminderTargetInputSchema,
  planningTagCreateInputSchema,
  planningTagUpdateInputSchema,
  planningTodoCreateInputSchema,
  planningTodoGetInputSchema,
  planningTodoListInputSchema,
  planningTodoPurgeInputSchema,
  planningTodoRevisionInputSchema,
  planningTodoUpdateInputSchema,
} from "./schemas";
import { validateInput } from "./validation";
import type { NotificationWriter, RpcHandler } from "./types";
import { startPlanningTodo } from "../services/planning/planning-start-service";
import { planningTodoStartInputSchema } from "./schemas";
import { getPlanningCalendarStore } from "../services/planning/planning-calendar-store";

export function createPlanningTodoHandlers(input: {
  writeNotification: NotificationWriter;
}): Record<string, RpcHandler> {
  const store = getPlanningTodoStore({
    onChange: (event) =>
      input.writeNotification(PLANNING_TODO_IPC_CHANNELS.CHANGED, event),
  });
  const calendar = getPlanningCalendarStore({
    onChange: (event) =>
      input.writeNotification(PLANNING_TODO_IPC_CHANNELS.CHANGED, event),
  });
  const revision = async (
    params: unknown,
    operation: "complete" | "reopen" | "delete" | "restore",
  ) => {
    const value = validateInput(
      planningTodoRevisionInputSchema,
      params,
      operation,
    );
    return store[operation](value);
  };
  return {
    [PLANNING_TODO_IPC_CHANNELS.LIST]: async (params) =>
      store.list(
        validateInput(
          planningTodoListInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.LIST,
        ),
      ),
    [PLANNING_TODO_IPC_CHANNELS.GET]: async (params) => ({
      schemaVersion: 1,
      todo: store.get(
        validateInput(
          planningTodoGetInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.GET,
        ).todoId,
      ),
    }),
    [PLANNING_TODO_IPC_CHANNELS.CREATE]: async (params) =>
      store.create(
        validateInput(
          planningTodoCreateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.CREATE,
        ) as PlanningTodoCreateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.UPDATE]: async (params) =>
      store.update(
        validateInput(
          planningTodoUpdateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.UPDATE,
        ) as PlanningTodoUpdateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.COMPLETE]: async (params) =>
      revision(params, "complete"),
    [PLANNING_TODO_IPC_CHANNELS.REOPEN]: async (params) =>
      revision(params, "reopen"),
    [PLANNING_TODO_IPC_CHANNELS.DELETE]: async (params) =>
      revision(params, "delete"),
    [PLANNING_TODO_IPC_CHANNELS.RESTORE]: async (params) =>
      revision(params, "restore"),
    [PLANNING_TODO_IPC_CHANNELS.PURGE]: async (params) =>
      store.purge(
        validateInput(
          planningTodoPurgeInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.PURGE,
        ) as PlanningTodoPurgeInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.COUNT]: async (params) => {
      const value = validateInput(
        planningTodoListInputSchema.pick({ workspaceId: true }),
        params,
        PLANNING_TODO_IPC_CHANNELS.COUNT,
      );
      return {
        workspaceId: value.workspaceId,
        open: store.count(value.workspaceId),
      };
    },
    [PLANNING_TODO_IPC_CHANNELS.START]: async (params) =>
      startPlanningTodo(
        validateInput(
          planningTodoStartInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.START,
        ),
        "start",
      ),
    [PLANNING_TODO_IPC_CHANNELS.CONTINUE]: async (params) =>
      startPlanningTodo(
        validateInput(
          planningTodoStartInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.CONTINUE,
        ),
        "continue",
      ),
    [PLANNING_TODO_IPC_CHANNELS.LIST_CALENDAR_EVENTS]: async (params) =>
      calendar.listEvents(
        validateInput(
          planningCalendarEventListInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.LIST_CALENDAR_EVENTS,
        ),
      ),
    [PLANNING_TODO_IPC_CHANNELS.GET_CALENDAR_EVENT]: async (params) =>
      calendar.getEvent(
        validateInput(
          planningCalendarEventIdSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.GET_CALENDAR_EVENT,
        ).eventId,
      ),
    [PLANNING_TODO_IPC_CHANNELS.CREATE_CALENDAR_EVENT]: async (params) =>
      calendar.createEvent(
        validateInput(
          planningCalendarEventCreateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.CREATE_CALENDAR_EVENT,
        ) as PlanningCalendarEventCreateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.UPDATE_CALENDAR_EVENT]: async (params) =>
      calendar.updateEvent(
        validateInput(
          planningCalendarEventUpdateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.UPDATE_CALENDAR_EVENT,
        ) as PlanningCalendarEventUpdateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.DELETE_CALENDAR_EVENT]: async (params) => {
      const value = validateInput(
        planningCalendarEventDeleteInputSchema,
        params,
        PLANNING_TODO_IPC_CHANNELS.DELETE_CALENDAR_EVENT,
      );
      return calendar.deleteEvent(value.eventId, value.expectedRevision);
    },
    [PLANNING_TODO_IPC_CHANNELS.LIST_GROUPS]: async (params) =>
      calendar.listGroups(
        validateInput(
          planningGroupListInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.LIST_GROUPS,
        ).scope,
      ),
    [PLANNING_TODO_IPC_CHANNELS.CREATE_GROUP]: async (params) =>
      calendar.createGroup(
        validateInput(
          planningGroupCreateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.CREATE_GROUP,
        ) as PlanningGroupCreateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.UPDATE_GROUP]: async (params) =>
      calendar.updateGroup(
        validateInput(
          planningGroupUpdateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.UPDATE_GROUP,
        ) as PlanningGroupUpdateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.DELETE_GROUP]: async (params) => {
      const value = validateInput(
        planningEntityDeleteInputSchema,
        params,
        PLANNING_TODO_IPC_CHANNELS.DELETE_GROUP,
      );
      calendar.deleteGroup("calendar", value.id);
      return { ok: true };
    },
    [PLANNING_TODO_IPC_CHANNELS.LIST_TAGS]: async () => calendar.listTags(),
    [PLANNING_TODO_IPC_CHANNELS.CREATE_TAG]: async (params) =>
      calendar.createTag(
        validateInput(
          planningTagCreateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.CREATE_TAG,
        ) as PlanningTagCreateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.UPDATE_TAG]: async (params) =>
      calendar.updateTag(
        validateInput(
          planningTagUpdateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.UPDATE_TAG,
        ) as PlanningTagUpdateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.DELETE_TAG]: async (params) => {
      const value = validateInput(
        planningEntityDeleteInputSchema,
        params,
        PLANNING_TODO_IPC_CHANNELS.DELETE_TAG,
      );
      calendar.deleteTag(value.id);
      return { ok: true };
    },
    [PLANNING_TODO_IPC_CHANNELS.CREATE_REMINDER]: async (params) =>
      calendar.createReminder(
        validateInput(
          planningReminderCreateInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.CREATE_REMINDER,
        ) as PlanningReminderCreateInput,
      ),
    [PLANNING_TODO_IPC_CHANNELS.DELETE_REMINDER]: async (params) => {
      const value = validateInput(
        planningReminderIdSchema,
        params,
        PLANNING_TODO_IPC_CHANNELS.DELETE_REMINDER,
      );
      calendar.deleteReminder(value.reminderId);
      return { ok: true };
    },
    [PLANNING_TODO_IPC_CHANNELS.LIST_REMINDERS]: async (params) => {
      const value = validateInput(
        planningReminderTargetInputSchema,
        params,
        PLANNING_TODO_IPC_CHANNELS.LIST_REMINDERS,
      );
      return calendar.listReminders(value.targetType, value.targetId);
    },
    [PLANNING_TODO_IPC_CHANNELS.LIST_ACTIVE_REMINDERS]: async () =>
      calendar.listActiveReminders(),
    [PLANNING_TODO_IPC_CHANNELS.ACKNOWLEDGE_REMINDER]: async (params) =>
      calendar.acknowledgeReminder(
        validateInput(
          planningReminderIdSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.ACKNOWLEDGE_REMINDER,
        ).reminderId,
      ),
    [PLANNING_TODO_IPC_CHANNELS.SNOOZE_REMINDER]: async (params) =>
      calendar.snoozeReminder(
        validateInput(
          planningReminderSnoozeInputSchema,
          params,
          PLANNING_TODO_IPC_CHANNELS.SNOOZE_REMINDER,
        ) as PlanningReminderSnoozeInput,
      ),
  };
}
