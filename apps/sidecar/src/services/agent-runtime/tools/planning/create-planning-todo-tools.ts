import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@lume/agent-sdk";
import type { PlanningTodo, PlanningTodoPriority } from "@lume/shared";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { getPlanningTodoStore } from "../../../planning/planning-todo-store";
import { addPlanningAuthorizedTodo, authorizePlanningOperation, type ExecutionSurfaceContext } from "../../../planning/planning-execution-context";

const todoId = Type.String({ format: "uuid" });
const priority = Type.Union([Type.Literal("none"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function id(value: unknown): string { const result = text(value); if (!result) throw new Error("todoId 必填"); return result; }
function revision(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("expectedRevision 必须是非负整数"); return value; }
export function createPlanningTodoTools(input: { workspaceId?: string; executionContext?: ExecutionSurfaceContext }): ToolDefinition[] {
  const store = getPlanningTodoStore();
  const accessible = (todo: PlanningTodo) => {
    const globalRead = input.executionContext?.globalPlanningRead === true;
    const explicitlyAuthorized = input.executionContext?.authorizedTodoIds.includes(todo.id) === true;
    if (explicitlyAuthorized) return;
    if (!globalRead && todo.workspaceId && input.workspaceId && todo.workspaceId !== input.workspaceId) throw new Error("Planning Todo 不属于当前项目");
    if (!globalRead && todo.workspaceId && !input.workspaceId) throw new Error("无项目线程不能直接访问项目 Todo");
  };
  const common = { runtimeMetadata: { source: "lume", category: "read", capability: "planning", riskLevel: "low", sideEffects: "local_read", allowedInPlanMode: true, isReadOnly: true, isConcurrencySafe: true, requiresWorkspace: false, resultPolicy: { maxChars: 50_000 } } };
  const list = createSdkJsonResultTool({ name: "PlanningTodoList", description: "查询持久化 Planning Todo。它与 TodoWrite 执行清单和 Task 线程编排独立。", inputSchema: Type.Object({ view: Type.Optional(Type.String()), search: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()), scope: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("all"), Type.Literal("unassigned")])) }) as never, isReadOnly: true, isConcurrencySafe: true, ...common, async call(raw) {
    const scope = text(raw.scope) as "current" | "all" | "unassigned" | undefined;
    const globalRead = input.executionContext?.globalPlanningRead === true;
    const effectiveScope = scope ?? (globalRead ? "all" : input.workspaceId ? "current" : "unassigned");
    authorizePlanningOperation(input.executionContext, { operation: "list", scope: effectiveScope });
    const listed = store.list({ workspaceId: input.workspaceId, scope: effectiveScope, view: text(raw.view) as never, search: text(raw.search), limit: typeof raw.limit === "number" ? raw.limit : undefined });
    for (const todo of listed.items) addPlanningAuthorizedTodo(input.executionContext!, todo.id);
    return { schemaVersion: 1, operation: "list", items: listed.items, nextCursor: listed.nextCursor };
  }});
  const get = createSdkJsonResultTool({ name: "PlanningTodoGet", description: "读取一个 Planning Todo 的最新快照。", inputSchema: Type.Object({ todoId }) as never, isReadOnly: true, isConcurrencySafe: true, ...common, async call(raw) { const todo = store.get(id(raw.todoId)); accessible(todo); authorizePlanningOperation(input.executionContext, { operation: "get", todo, todoId: todo.id, scope: "todo" }); addPlanningAuthorizedTodo(input.executionContext!, todo.id); return { schemaVersion: 1, operation: "get", todo }; } });
  const writeMetadata = { source: "lume", category: "write", capability: "planning", riskLevel: "medium", sideEffects: "local_write", allowedInPlanMode: false, isReadOnly: false, isConcurrencySafe: false, requiresWorkspace: false, resultPolicy: { maxChars: 50_000 } };
  const create = createSdkJsonResultTool({ name: "PlanningTodoCreate", description: "明确记录用户要求长期保留的 Planning Todo；不要把 Agent 内部步骤写入这里。", inputSchema: Type.Object({ title: Type.String({ minLength: 1 }), description: Type.Optional(Type.String()), priority: Type.Optional(priority), workspaceId: Type.Optional(Type.String({ format: "uuid" })), dueDate: Type.Optional(Type.String()), dueAt: Type.Optional(Type.Number()), dueTimezone: Type.Optional(Type.String()) }) as never, ...writeMetadata, async call(raw) { const requestedWorkspaceId = text(raw.workspaceId); if (requestedWorkspaceId && input.workspaceId && requestedWorkspaceId !== input.workspaceId) throw new Error("Planning Todo 不能写入其他项目"); const workspaceId = requestedWorkspaceId ?? input.workspaceId; authorizePlanningOperation(input.executionContext, { operation: "create", scope: workspaceId ? "current" : "unassigned", targetWorkspaceId: workspaceId }); return store.create({ title: String(raw.title), description: text(raw.description), priority: raw.priority as PlanningTodoPriority | undefined, workspaceId, dueDate: text(raw.dueDate), dueAt: typeof raw.dueAt === "number" ? raw.dueAt : undefined, dueTimezone: text(raw.dueTimezone) }); } });
  const mutation = (name: "PlanningTodoUpdate" | "PlanningTodoComplete" | "PlanningTodoReopen" | "PlanningTodoDelete" | "PlanningTodoRestore", operation: "update" | "complete" | "reopen" | "delete" | "restore"): ToolDefinition => createSdkJsonResultTool({ name, description: `更新 Planning Todo（${operation}）。`, inputSchema: (operation === "update" ? Type.Object({ todoId, expectedRevision: Type.Number(), patch: Type.Object({ title: Type.Optional(Type.String()), description: Type.Optional(Type.Union([Type.String(), Type.Null()])), priority: Type.Optional(priority), workspaceId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])), dueDate: Type.Optional(Type.Union([Type.String(), Type.Null()])), dueAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])), dueTimezone: Type.Optional(Type.Union([Type.String(), Type.Null()])) }) }) : Type.Object({ todoId, expectedRevision: Type.Number() })) as never, ...writeMetadata, async call(raw) { const todo = store.get(id(raw.todoId)); accessible(todo); const targetWorkspaceId = operation === "update" && raw.patch && Object.prototype.hasOwnProperty.call(raw.patch, "workspaceId") ? (raw.patch as { workspaceId?: string | null }).workspaceId : todo.workspaceId; authorizePlanningOperation(input.executionContext, { operation, todo, todoId: todo.id, scope: "todo", targetWorkspaceId }); if (operation === "update") return store.update({ todoId: todo.id, expectedRevision: revision(raw.expectedRevision), patch: raw.patch as never }); return store[operation]({ todoId: todo.id, expectedRevision: revision(raw.expectedRevision) }); } });
  if (input.executionContext?.surface === "routine" || input.executionContext?.surface === "automation") return [list, get];
  return [list, get, create, mutation("PlanningTodoUpdate", "update"), mutation("PlanningTodoComplete", "complete"), mutation("PlanningTodoReopen", "reopen"), mutation("PlanningTodoDelete", "delete"), mutation("PlanningTodoRestore", "restore")];
}
