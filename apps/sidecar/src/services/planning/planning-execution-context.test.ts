import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { authorizePlanningOperation, issuePlanningScopeGrant, registerPlanningExecutionContext } from "./planning-execution-context";

describe("planning execution grants", () => {
  test("binds a current-project grant to the trusted run and rejects mutation outside its scope", () => {
    const clientSubmissionId = randomUUID();
    const context = registerPlanningExecutionContext({ surface: "main", threadId: "thread-grant", clientSubmissionId, workspaceId: "workspace-a" });
    issuePlanningScopeGrant({ clientSubmissionId, surface: "main", scope: "current", workspaceId: "workspace-a", allowedOperations: ["get", "update"], mode: "turn" });
    const todo = { id: randomUUID(), title: "x", normalizedTitle: "x", status: "open" as const, priority: "none" as const, workspaceId: "workspace-a", revision: 0, createdAt: 0, updatedAt: 0 };
    expect(() => authorizePlanningOperation(context, { operation: "get", todo, todoId: todo.id, scope: "todo" })).not.toThrow();
    expect(() => authorizePlanningOperation(context, { operation: "update", todo: { ...todo, workspaceId: "workspace-b" }, todoId: todo.id, scope: "todo" })).toThrow();
    expect(() => authorizePlanningOperation(context, { operation: "update", todo, todoId: todo.id, scope: "todo", targetWorkspaceId: null })).toThrow();
    expect(() => authorizePlanningOperation(context, { operation: "create", scope: "current" })).toThrow();
  });

  test("does not let a read-only grant perform a write", () => {
    const clientSubmissionId = randomUUID();
    const context = registerPlanningExecutionContext({ surface: "automation", threadId: "thread-read", clientSubmissionId });
    issuePlanningScopeGrant({ clientSubmissionId, surface: "automation", scope: "all", allowedOperations: ["list", "get"], mode: "turn" });
    const todoId = randomUUID();
    expect(() => authorizePlanningOperation(context, { operation: "list", scope: "all" })).not.toThrow();
    expect(() => authorizePlanningOperation(context, { operation: "delete", scope: "todo", todoId })).toThrow();
  });
});
