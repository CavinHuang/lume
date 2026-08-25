import type { AgentSendInput, PlanningTodo } from "@lume/shared";
import type { CreateRuntimeCoreSessionInput } from "./run";
import type { resolvePlanningExecutionContext } from "../../planning/planning-execution-context";
import { getPlanningTodoStore } from "../../planning/planning-todo-store";

export function resolvePlanningTodoContext(
  input: Pick<
    CreateRuntimeCoreSessionInput,
    "lumeSessionId" | "messageParts" | "messageMetadata"
  >,
  executionContext: ReturnType<typeof resolvePlanningExecutionContext>,
): Array<
  Pick<
    PlanningTodo,
    | "id"
    | "title"
    | "description"
    | "status"
    | "priority"
    | "workspaceId"
    | "dueDate"
    | "dueAt"
    | "dueTimezone"
    | "revision"
  >
> {
  if (!executionContext) return [];
  const parts =
    input.messageParts ??
    (Array.isArray(input.messageMetadata?.messageParts)
      ? (input.messageMetadata.messageParts as AgentSendInput["messageParts"])
      : undefined) ??
    [];
  const ids = new Set(executionContext.authorizedTodoIds);
  if (
    executionContext.surface === "main" ||
    executionContext.surface === "quick-input"
  ) {
    for (const todo of getPlanningTodoStore().listPrimaryTodosForThread(
      input.lumeSessionId,
    )) {
      if (ids.has(todo.id))
        parts.push({
          type: "planning_todo_ref",
          schemaVersion: 1,
          uri: `lume://planning/todo/${todo.id}`,
          todoId: todo.id,
          relation: "primary",
          displayText: todo.title,
        });
    }
  }
  const snapshots = new Map<string, PlanningTodo>();
  for (const part of parts) {
    if (part?.type !== "planning_todo_ref" || !ids.has(part.todoId)) continue;
    try {
      const todo = getPlanningTodoStore().get(part.todoId);
      if (todo.status === "open" && !todo.deletedAt)
        snapshots.set(todo.id, todo);
    } catch {
      /* historical/deleted refs remain unavailable in the editor */
    }
  }
  return [...snapshots.values()].map(
    ({
      id,
      title,
      description,
      status,
      priority,
      workspaceId,
      dueDate,
      dueAt,
      dueTimezone,
      revision,
    }) => ({
      id,
      title,
      ...(description ? { description } : {}),
      status,
      priority,
      ...(workspaceId ? { workspaceId } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(dueTimezone ? { dueTimezone } : {}),
      revision,
    }),
  );
}
