import type { AgentMessage } from "@lume/shared";
import type { ToolActivity } from "@/atoms/agent-atoms";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function parseTodoItemsFromInput(input: Record<string, unknown>): TodoItem[] | null {
  if (!Array.isArray(input.todos)) return null;
  const todos = (input.todos as Array<Record<string, unknown>>).map((todo) => ({
    content: String(todo.subject ?? todo.content ?? ""),
    status: (todo.status as TodoItem["status"]) ?? "pending",
    activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined
  })).filter((todo) => todo.content.trim().length > 0);
  return todos.length > 0 ? todos : null;
}

export function findLatestTodoItems(toolActivities: ToolActivity[], messages: AgentMessage[]): TodoItem[] | null {
  for (let i = toolActivities.length - 1; i >= 0; i -= 1) {
    const activity = toolActivities[i];
    if (!activity) continue;
    if (activity.toolName !== "TodoWrite" && activity.toolName !== "TaskCreate") continue;
    const todos = parseTodoItemsFromInput(activity.input);
    if (todos) return todos;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !message.events) continue;
    for (let j = message.events.length - 1; j >= 0; j -= 1) {
      const event = message.events[j];
      if (!event || event.type !== "tool_start") continue;
      if (event.toolName !== "TodoWrite" && event.toolName !== "TaskCreate") continue;
      const todos = parseTodoItemsFromInput(event.input);
      if (todos) return todos;
    }
  }

  return null;
}

export function resolveTodoPanelExpanded(
  previousItems: TodoItem[] | null,
  nextItems: TodoItem[]
): boolean | null {
  const allCompleted = nextItems.every((todo) => todo.status === "completed");
  const isInitialLoad = previousItems === null;

  if (isInitialLoad) {
    return !allCompleted;
  }

  const isNewTodo = previousItems.length !== nextItems.length
    || previousItems.some((prev, idx) => prev.content !== nextItems[idx]?.content);
  const wasNotAllCompleted = !previousItems.every((todo) => todo.status === "completed");

  if (isNewTodo && !allCompleted) {
    return true;
  }
  if (wasNotAllCompleted && allCompleted) {
    return false;
  }
  return null;
}
