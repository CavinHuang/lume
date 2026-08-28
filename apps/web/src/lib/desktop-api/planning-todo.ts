import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import {
  PLANNING_TODO_IPC_CHANNELS,
  type ActivePlanningReminder,
  type PlanningCalendarEvent,
  type PlanningCalendarEventCreateInput,
  type PlanningCalendarEventListInput,
  type PlanningCalendarEventUpdateInput,
  type PlanningGroup,
  type PlanningGroupCreateInput,
  type PlanningGroupScope,
  type PlanningGroupUpdateInput,
  type PlanningReminder,
  type PlanningReminderCreateInput,
  type PlanningReminderSnoozeInput,
  type PlanningTag,
  type PlanningTagCreateInput,
  type PlanningTagUpdateInput,
  type PlanningTodoChangeEvent,
  type PlanningTodoCreateInput,
  type PlanningTodoListInput,
  type PlanningTodoListResult,
  type PlanningTodoMutationResult,
  type PlanningTodoRevisionInput,
  type PlanningTodoUpdateInput,
  type PlanningTodo,
  type PlanningTodoStartInput,
  type PlanningTodoStartResult,
} from '@lume/shared'

const call = <T>(method: string, params: unknown) =>
  invoke<T>('sidecar_call', { method, params })

export const listPlanningTodos = (input: PlanningTodoListInput = {}) =>
  call<PlanningTodoListResult>(PLANNING_TODO_IPC_CHANNELS.LIST, input)
export const getPlanningTodo = (todoId: string) =>
  call<{ schemaVersion: 1; todo: PlanningTodo }>(
    PLANNING_TODO_IPC_CHANNELS.GET,
    { todoId },
  )
export const createPlanningTodo = (input: PlanningTodoCreateInput) =>
  call<PlanningTodoMutationResult>(PLANNING_TODO_IPC_CHANNELS.CREATE, input)
export const updatePlanningTodo = (input: PlanningTodoUpdateInput) =>
  call<PlanningTodoMutationResult>(PLANNING_TODO_IPC_CHANNELS.UPDATE, input)
export const completePlanningTodo = (input: PlanningTodoRevisionInput) =>
  call<PlanningTodoMutationResult>(PLANNING_TODO_IPC_CHANNELS.COMPLETE, input)
export const reopenPlanningTodo = (input: PlanningTodoRevisionInput) =>
  call<PlanningTodoMutationResult>(PLANNING_TODO_IPC_CHANNELS.REOPEN, input)
export const deletePlanningTodo = (input: PlanningTodoRevisionInput) =>
  call<PlanningTodoMutationResult>(PLANNING_TODO_IPC_CHANNELS.DELETE, input)
export const restorePlanningTodo = (input: PlanningTodoRevisionInput) =>
  call<PlanningTodoMutationResult>(PLANNING_TODO_IPC_CHANNELS.RESTORE, input)
export const purgePlanningTodo = (input: PlanningTodoRevisionInput) =>
  call<PlanningTodoMutationResult>(PLANNING_TODO_IPC_CHANNELS.PURGE, {
    ...input,
    confirmation: true,
  })
export const countPlanningTodos = (workspaceId?: string) =>
  call<{ workspaceId?: string; open: number }>(
    PLANNING_TODO_IPC_CHANNELS.COUNT,
    workspaceId ? { workspaceId } : {},
  )
export const startPlanningTodo = (input: PlanningTodoStartInput) =>
  call<PlanningTodoStartResult>(PLANNING_TODO_IPC_CHANNELS.START, input)
export const listPlanningCalendarEvents = (
  input: PlanningCalendarEventListInput = {},
) =>
  call<PlanningCalendarEvent[]>(
    PLANNING_TODO_IPC_CHANNELS.LIST_CALENDAR_EVENTS,
    input,
  )
export const getPlanningCalendarEvent = (eventId: string) =>
  call<PlanningCalendarEvent>(PLANNING_TODO_IPC_CHANNELS.GET_CALENDAR_EVENT, {
    eventId,
  })
export const createPlanningCalendarEvent = (
  input: PlanningCalendarEventCreateInput,
) =>
  call<PlanningCalendarEvent>(
    PLANNING_TODO_IPC_CHANNELS.CREATE_CALENDAR_EVENT,
    input,
  )
export const updatePlanningCalendarEvent = (
  input: PlanningCalendarEventUpdateInput,
) =>
  call<PlanningCalendarEvent>(
    PLANNING_TODO_IPC_CHANNELS.UPDATE_CALENDAR_EVENT,
    input,
  )
export const deletePlanningCalendarEvent = (
  eventId: string,
  expectedRevision: number,
) =>
  call<PlanningCalendarEvent>(
    PLANNING_TODO_IPC_CHANNELS.DELETE_CALENDAR_EVENT,
    { eventId, expectedRevision },
  )
export const listPlanningGroups = (scope: PlanningGroupScope) =>
  call<PlanningGroup[]>(PLANNING_TODO_IPC_CHANNELS.LIST_GROUPS, { scope })
export const createPlanningGroup = (input: PlanningGroupCreateInput) =>
  call<PlanningGroup>(PLANNING_TODO_IPC_CHANNELS.CREATE_GROUP, input)
export const updatePlanningGroup = (input: PlanningGroupUpdateInput) =>
  call<PlanningGroup>(PLANNING_TODO_IPC_CHANNELS.UPDATE_GROUP, input)
export const deletePlanningGroup = (id: string) =>
  call<{ ok: true }>(PLANNING_TODO_IPC_CHANNELS.DELETE_GROUP, { id })
export const listPlanningTags = () =>
  call<PlanningTag[]>(PLANNING_TODO_IPC_CHANNELS.LIST_TAGS, {})
export const createPlanningTag = (input: PlanningTagCreateInput) =>
  call<PlanningTag>(PLANNING_TODO_IPC_CHANNELS.CREATE_TAG, input)
export const updatePlanningTag = (input: PlanningTagUpdateInput) =>
  call<PlanningTag>(PLANNING_TODO_IPC_CHANNELS.UPDATE_TAG, input)
export const deletePlanningTag = (id: string) =>
  call<{ ok: true }>(PLANNING_TODO_IPC_CHANNELS.DELETE_TAG, { id })
export const createPlanningReminder = (input: PlanningReminderCreateInput) =>
  call<PlanningReminder>(PLANNING_TODO_IPC_CHANNELS.CREATE_REMINDER, input)
export const deletePlanningReminder = (reminderId: string) =>
  call<{ ok: true }>(PLANNING_TODO_IPC_CHANNELS.DELETE_REMINDER, {
    reminderId,
  })
export const listPlanningReminders = (
  targetType: PlanningReminderCreateInput['targetType'],
  targetId: string,
) =>
  call<PlanningReminder[]>(PLANNING_TODO_IPC_CHANNELS.LIST_REMINDERS, {
    targetType,
    targetId,
  })
export const listActivePlanningReminders = () =>
  call<ActivePlanningReminder[]>(
    PLANNING_TODO_IPC_CHANNELS.LIST_ACTIVE_REMINDERS,
    {},
  )
export const acknowledgePlanningReminder = (reminderId: string) =>
  call<PlanningReminder>(PLANNING_TODO_IPC_CHANNELS.ACKNOWLEDGE_REMINDER, {
    reminderId,
  })
export const snoozePlanningReminder = (input: PlanningReminderSnoozeInput) =>
  call<PlanningReminder>(PLANNING_TODO_IPC_CHANNELS.SNOOZE_REMINDER, input)
export const onPlanningRemindersDue = (
  listener: (items: ActivePlanningReminder[]) => void,
) =>
  listen<{ method: string; params: unknown }>('sidecar:event', (event) => {
    if (event.payload?.method === PLANNING_TODO_IPC_CHANNELS.REMINDER_DUE)
      listener(event.payload.params as ActivePlanningReminder[])
  })
export const onPlanningTodoChange = (
  listener: (event: PlanningTodoChangeEvent) => void,
) =>
  listen<{ method: string; params: unknown }>('sidecar:event', (event) => {
    if (event.payload?.method === PLANNING_TODO_IPC_CHANNELS.CHANGED)
      listener(event.payload.params as PlanningTodoChangeEvent)
  })
