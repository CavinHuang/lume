/** Durable, user-owned Planning Todo contracts. Kept separate from TodoWrite and Task*. */

export type PlanningTodoStatus = "open" | "completed";
export type PlanningTodoPriority = "none" | "low" | "medium" | "high";
export type PlanningTodoRelation = "mentioned" | "primary";

export interface PlanningTodo {
  id: string;
  title: string;
  normalizedTitle: string;
  description?: string;
  status: PlanningTodoStatus;
  priority: PlanningTodoPriority;
  workspaceId?: string;
  dueDate?: string;
  dueAt?: number;
  dueTimezone?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  deletedAt?: number;
}

export interface PlanningTodoRefPart {
  type: "planning_todo_ref";
  schemaVersion: 1;
  uri: string;
  todoId: string;
  relation: PlanningTodoRelation;
  displayText: string;
}

export type PlanningTodoListView =
  "open" | "today" | "upcoming" | "completed" | "trash" | "all";
export type PlanningTodoScope = "current" | "all" | "unassigned";

export interface PlanningTodoListInput {
  workspaceId?: string;
  scope?: PlanningTodoScope;
  view?: PlanningTodoListView;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface PlanningTodoGetInput {
  todoId: string;
}

export interface PlanningTodoCreateInput {
  title: string;
  description?: string;
  priority?: PlanningTodoPriority;
  workspaceId?: string;
  dueDate?: string;
  dueAt?: number;
  dueTimezone?: string;
}

export interface PlanningTodoUpdateInput {
  todoId: string;
  expectedRevision: number;
  patch: Partial<Pick<PlanningTodo, "title" | "priority">> & {
    description?: string | null;
    workspaceId?: string | null;
    dueDate?: string | null;
    dueAt?: number | null;
    dueTimezone?: string | null;
  };
}

export interface PlanningTodoRevisionInput {
  todoId: string;
  expectedRevision: number;
}
export interface PlanningTodoPurgeInput {
  todoId: string;
  expectedRevision: number;
  confirmation: true;
}

export interface PlanningTodoMutationResult {
  schemaVersion: 1;
  operation:
    | "create"
    | "update"
    | "complete"
    | "reopen"
    | "delete"
    | "restore"
    | "purge";
  todo?: PlanningTodo;
  previous?: PlanningTodo;
  deduplicated?: boolean;
  eventSeq?: number;
}

export interface PlanningTodoListResult {
  schemaVersion: 1;
  items: PlanningTodo[];
  nextCursor?: string;
}

export interface PlanningTodoCountResult {
  workspaceId?: string;
  open: number;
}
export interface PlanningTodoStartInput {
  todoId: string;
  expectedRevision: number;
  workspaceId?: string;
  idempotencyKey: string;
  newThread?: boolean;
}
export interface PlanningTodoStartResult {
  schemaVersion: 1;
  operation: PlanningOperationEnvelope;
  threadId?: string;
  todo: PlanningTodo;
}

export type PlanningGroupScope = "todo" | "calendar";
export type PlanningReminderTargetType = "todo" | "calendar_event";
export type PlanningReminderStatus = "pending" | "acknowledged" | "completed";
export type PlanningReminderOrigin = "manual" | "todo_due_at";
export type PlanningChangeResource =
  | "todos"
  | "calendar_events"
  | "todo_groups"
  | "calendar_groups"
  | "tags"
  | "reminders";

export interface PlanningGroup {
  id: string;
  scope: PlanningGroupScope;
  name: string;
  color?: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}
export interface PlanningTag {
  id: string;
  name: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
}
export interface PlanningReminder {
  id: string;
  targetType: PlanningReminderTargetType;
  targetId: string;
  triggerAt: number;
  snoozedUntil?: number;
  status: PlanningReminderStatus;
  origin: PlanningReminderOrigin;
  acknowledgedAt?: number;
  lastNotifiedAt?: number;
  createdAt: number;
  updatedAt: number;
}
export interface ActivePlanningReminder extends PlanningReminder {
  targetTitle: string;
  workspaceId?: string;
  group?: PlanningGroup;
  tags: PlanningTag[];
}
export interface PlanningCalendarEvent {
  id: string;
  title: string;
  notes?: string;
  startAt: number;
  endAt?: number;
  allDay: boolean;
  groupId?: string;
  group?: PlanningGroup;
  tags: PlanningTag[];
  reminders: PlanningReminder[];
  workspaceId?: string;
  todoId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface PlanningCalendarEventListInput {
  from?: number;
  to?: number;
  workspaceId?: string;
  scope?: PlanningTodoScope;
  limit?: number;
}
export interface PlanningCalendarEventCreateInput {
  title: string;
  notes?: string;
  startAt: number;
  endAt?: number;
  allDay?: boolean;
  groupId?: string;
  tagIds?: string[];
  reminderTimes?: number[];
  workspaceId?: string;
  todoId?: string;
}
export interface PlanningCalendarEventUpdateInput {
  eventId: string;
  expectedRevision: number;
  patch: {
    title?: string;
    notes?: string | null;
    startAt?: number;
    endAt?: number | null;
    allDay?: boolean;
    groupId?: string | null;
    tagIds?: string[];
    workspaceId?: string | null;
    todoId?: string | null;
  };
}
export interface PlanningGroupCreateInput {
  scope: PlanningGroupScope;
  name: string;
  color?: string;
  sortOrder?: number;
}
export interface PlanningGroupUpdateInput {
  groupId: string;
  scope: PlanningGroupScope;
  name?: string;
  color?: string | null;
  sortOrder?: number;
}
export interface PlanningTagCreateInput {
  name: string;
  color?: string;
}
export interface PlanningTagUpdateInput {
  tagId: string;
  name?: string;
  color?: string | null;
}
export interface PlanningReminderCreateInput {
  targetType: PlanningReminderTargetType;
  targetId: string;
  triggerAt: number;
}
export interface PlanningReminderSnoozeInput {
  reminderId: string;
  minutes: number;
}

export type PlanningOperationKind =
  | "start"
  | "continue"
  | "project_keep_history"
  | "project_delete_lume_data"
  | "thread_delete";
export type PlanningOperationStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "reconciling"
  | "compensated";
export type PlanningOperationCompensation =
  "none" | "pending" | "completed" | "failed";
export type PlanningStartPhase =
  | "reserved"
  | "thread_created"
  | "submission_accepted"
  | "link_committed"
  | "compensating"
  | "reconciled"
  | "finalized";
export type PlanningContinuePhase =
  | "reserved"
  | "submission_accepted"
  | "link_touched"
  | "reconciled"
  | "finalized";
export type PlanningProjectPhase =
  | "prepared"
  | "planning_committed"
  | "threads_processed"
  | "workspace_removed"
  | "compensating"
  | "finalized";
export type PlanningThreadDeletePhase =
  | "prepared"
  | "links_tombstoned"
  | "index_removed"
  | "files_removed"
  | "cleanup_pending"
  | "compensating"
  | "finalized";
export type PlanningOperationPhase =
  | PlanningStartPhase
  | PlanningContinuePhase
  | PlanningProjectPhase
  | PlanningThreadDeletePhase;

interface PlanningOperationBase {
  schemaVersion: 1;
  operationId: string;
  clientSubmissionId?: string;
  status: PlanningOperationStatus;
  recoverable: boolean;
  compensation: PlanningOperationCompensation;
  todoId?: string;
  threadId?: string;
  error?: string;
  updatedAt: number;
}

export type PlanningOperationEnvelope =
  | (PlanningOperationBase & { kind: "start"; phase: PlanningStartPhase })
  | (PlanningOperationBase & { kind: "continue"; phase: PlanningContinuePhase })
  | (PlanningOperationBase & {
      kind: "project_keep_history" | "project_delete_lume_data";
      phase: PlanningProjectPhase;
    })
  | (PlanningOperationBase & {
      kind: "thread_delete";
      phase: PlanningThreadDeletePhase;
    });

export type PlanningOperationTransition = {
  phase: PlanningOperationPhase;
  status?: PlanningOperationStatus;
  compensation?: PlanningOperationCompensation;
  recoverable?: boolean;
  error?: string;
  todoId?: string;
  threadId?: string;
  updatedAt?: number;
};

export function createPlanningOperation(
  input: Pick<PlanningOperationEnvelope, "operationId" | "kind"> &
    Partial<
      Pick<
        PlanningOperationEnvelope,
        "todoId" | "threadId" | "clientSubmissionId"
      >
    > & { updatedAt?: number },
): PlanningOperationEnvelope {
  const base = {
    schemaVersion: 1 as const,
    operationId: input.operationId,
    status: "pending" as const,
    recoverable: true,
    compensation: "none" as const,
    ...(input.todoId ? { todoId: input.todoId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.clientSubmissionId
      ? { clientSubmissionId: input.clientSubmissionId }
      : {}),
    updatedAt: input.updatedAt ?? Date.now(),
  };
  if (input.kind === "start")
    return { ...base, kind: input.kind, phase: "reserved" };
  if (input.kind === "continue")
    return { ...base, kind: input.kind, phase: "reserved" };
  if (input.kind === "thread_delete")
    return { ...base, kind: input.kind, phase: "prepared" };
  return { ...base, kind: input.kind, phase: "prepared" };
}

export function reducePlanningOperation(
  current: PlanningOperationEnvelope,
  transition: PlanningOperationTransition,
): PlanningOperationEnvelope {
  const allowed: Record<PlanningOperationKind, readonly string[]> = {
    start: [
      "reserved",
      "thread_created",
      "submission_accepted",
      "link_committed",
      "compensating",
      "reconciled",
      "finalized",
    ],
    continue: [
      "reserved",
      "submission_accepted",
      "link_touched",
      "reconciled",
      "finalized",
    ],
    project_keep_history: [
      "prepared",
      "planning_committed",
      "threads_processed",
      "workspace_removed",
      "compensating",
      "finalized",
    ],
    project_delete_lume_data: [
      "prepared",
      "planning_committed",
      "threads_processed",
      "workspace_removed",
      "compensating",
      "finalized",
    ],
    thread_delete: [
      "prepared",
      "links_tombstoned",
      "index_removed",
      "files_removed",
      "cleanup_pending",
      "compensating",
      "finalized",
    ],
  };
  if (!allowed[current.kind].includes(transition.phase))
    throw new Error(
      `invalid planning operation phase: ${current.kind}/${transition.phase}`,
    );
  const phases = allowed[current.kind];
  const currentIndex = phases.indexOf(current.phase);
  const nextIndex = phases.indexOf(transition.phase);
  const compensating = transition.phase === "compensating";
  if (
    current.phase === "finalized" ||
    (!compensating && nextIndex < currentIndex)
  ) {
    throw new Error(
      `invalid planning operation transition: ${current.kind}/${current.phase} -> ${transition.phase}`,
    );
  }
  const terminal =
    transition.phase === "finalized" && transition.status === "completed";
  return {
    ...current,
    phase: transition.phase as never,
    status:
      transition.status ??
      (terminal
        ? "completed"
        : transition.phase === "reserved" || transition.phase === "prepared"
          ? "pending"
          : "running"),
    ...(transition.compensation
      ? { compensation: transition.compensation }
      : {}),
    ...(transition.recoverable !== undefined
      ? { recoverable: transition.recoverable }
      : {}),
    ...(transition.error ? { error: transition.error } : {}),
    ...(transition.todoId ? { todoId: transition.todoId } : {}),
    ...(transition.threadId ? { threadId: transition.threadId } : {}),
    updatedAt: transition.updatedAt ?? Date.now(),
  } as PlanningOperationEnvelope;
}

export interface PlanningTodoChangeEvent {
  eventSeq: number;
  todoId?: string;
  workspaceId?: string;
  operation?: string;
  updatedAt: number;
  resources?: PlanningChangeResource[];
}

export const PLANNING_TODO_IPC_CHANNELS = {
  LIST: "planning-todo:list",
  GET: "planning-todo:get",
  CREATE: "planning-todo:create",
  UPDATE: "planning-todo:update",
  COMPLETE: "planning-todo:complete",
  REOPEN: "planning-todo:reopen",
  DELETE: "planning-todo:delete",
  RESTORE: "planning-todo:restore",
  PURGE: "planning-todo:purge",
  COUNT: "planning-todo:count",
  START: "planning-todo:start",
  CONTINUE: "planning-todo:continue",
  CHANGED: "planning-todo:changed",
  LIST_CALENDAR_EVENTS: "planning-todo:list-calendar-events",
  GET_CALENDAR_EVENT: "planning-todo:get-calendar-event",
  CREATE_CALENDAR_EVENT: "planning-todo:create-calendar-event",
  UPDATE_CALENDAR_EVENT: "planning-todo:update-calendar-event",
  DELETE_CALENDAR_EVENT: "planning-todo:delete-calendar-event",
  LIST_GROUPS: "planning-todo:list-groups",
  CREATE_GROUP: "planning-todo:create-group",
  UPDATE_GROUP: "planning-todo:update-group",
  DELETE_GROUP: "planning-todo:delete-group",
  LIST_TAGS: "planning-todo:list-tags",
  CREATE_TAG: "planning-todo:create-tag",
  UPDATE_TAG: "planning-todo:update-tag",
  DELETE_TAG: "planning-todo:delete-tag",
  CREATE_REMINDER: "planning-todo:create-reminder",
  DELETE_REMINDER: "planning-todo:delete-reminder",
  LIST_REMINDERS: "planning-todo:list-reminders",
  LIST_ACTIVE_REMINDERS: "planning-todo:list-active-reminders",
  ACKNOWLEDGE_REMINDER: "planning-todo:acknowledge-reminder",
  SNOOZE_REMINDER: "planning-todo:snooze-reminder",
  REMINDER_DUE: "planning-todo:reminder-due",
} as const;

export function planningTodoUri(todoId: string): PlanningTodoRefPart["uri"] {
  return `lume://planning/todo/${todoId}`;
}

export function isPlanningTodoId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function normalizePlanningTodoTitle(title: string): string {
  return title
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

export function validatePlanningTodoRefPart(part: PlanningTodoRefPart): void {
  if (
    part.schemaVersion !== 1 ||
    !isPlanningTodoId(part.todoId) ||
    part.uri !== planningTodoUri(part.todoId)
  ) {
    throw new Error("invalid planning_todo_ref");
  }
  if (part.displayText.length === 0 || part.displayText.length > 240)
    throw new Error("invalid planning todo displayText");
}

export function validatePlanningTodoDueFields(
  input: Pick<PlanningTodo, "dueDate" | "dueAt" | "dueTimezone">,
): void {
  if (input.dueDate && (input.dueAt != null || input.dueTimezone != null))
    throw new Error("dueDate and dueAt are mutually exclusive");
  if (input.dueAt != null && !input.dueTimezone)
    throw new Error("dueTimezone is required with dueAt");
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/u.test(input.dueDate))
    throw new Error("invalid dueDate");
  if (input.dueTimezone) {
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: input.dueTimezone,
      }).format();
    } catch {
      throw new Error("invalid dueTimezone");
    }
  }
}
