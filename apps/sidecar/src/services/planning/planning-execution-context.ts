import { randomUUID } from "node:crypto";
import type { PlanningOperationKind, PlanningTodo, PlanningTodoRelation } from "@lume/shared";

export type PlanningExecutionSurface = "main" | "quick-input" | "im" | "routine" | "automation" | "subagent" | "recovery";
export type PlanningOperationName = "list" | "get" | "create" | "update" | "complete" | "reopen" | "delete" | "restore" | "start";
export type PlanningGrantMode = "turn" | "tool_call";
export type PlanningGrantScope = "current" | "all" | "unassigned" | "todo";

export interface PlanningScopeGrant {
  token: string;
  clientSubmissionId?: string;
  runId?: string;
  surface: PlanningExecutionSurface;
  scope: PlanningGrantScope;
  workspaceId?: string;
  todoIds?: readonly string[];
  allowedOperations: readonly PlanningOperationName[];
  mode: PlanningGrantMode;
  toolCallId?: string;
  expiresAt: number;
  consumed: boolean;
}

export interface ExecutionSurfaceContext {
  surface: PlanningExecutionSurface;
  threadId: string;
  workspaceId?: string;
  clientSubmissionId?: string;
  runId?: string;
  continuationOperationId?: string;
  globalPlanningRead?: boolean;
  planningScopeGrants: readonly string[];
  authorizedTodoIds: readonly string[];
}

interface ContextRecord extends ExecutionSurfaceContext { grants: Map<string, PlanningScopeGrant>; }

const contextsBySubmission = new Map<string, ContextRecord>();
const contextsByRun = new Map<string, ContextRecord>();

export function registerPlanningExecutionContext(input: Omit<ExecutionSurfaceContext, "planningScopeGrants" | "authorizedTodoIds"> & { planningScopeGrants?: readonly string[] }): ExecutionSurfaceContext {
  const context: ContextRecord = { ...input, planningScopeGrants: input.planningScopeGrants ?? [], authorizedTodoIds: [], grants: new Map() };
  if (context.clientSubmissionId) contextsBySubmission.set(context.clientSubmissionId, context);
  if (context.runId) contextsByRun.set(context.runId, context);
  return snapshot(context);
}

export function issuePlanningScopeGrant(input: Omit<PlanningScopeGrant, "token" | "consumed" | "expiresAt"> & { ttlMs?: number }): string {
  const token = randomUUID();
  const grant: PlanningScopeGrant = { ...input, token, consumed: false, expiresAt: Date.now() + Math.max(1_000, input.ttlMs ?? 5 * 60_000) };
  const context = input.clientSubmissionId ? contextsBySubmission.get(input.clientSubmissionId) : input.runId ? contextsByRun.get(input.runId) : undefined;
  if (!context) throw new Error("planning execution context not found");
  context.grants.set(token, grant);
  context.planningScopeGrants = [...context.planningScopeGrants, token];
  return token;
}

export function bindPlanningExecutionRun(clientSubmissionId: string, runId: string): ExecutionSurfaceContext {
  const context = contextsBySubmission.get(clientSubmissionId);
  if (!context) throw new Error("planning submission context not found");
  if (context.runId && context.runId !== runId) throw new Error("planning submission already bound to another run");
  context.runId = runId;
  contextsByRun.set(runId, context);
  for (const grant of context.grants.values()) {
    if (grant.clientSubmissionId === clientSubmissionId) grant.runId = runId;
  }
  return snapshot(context);
}

export function addPlanningAuthorizedTodo(context: ExecutionSurfaceContext, todoId: string): ExecutionSurfaceContext {
  const record = resolveRecord(context);
  if (!record.authorizedTodoIds.includes(todoId)) record.authorizedTodoIds = [...record.authorizedTodoIds, todoId];
  return snapshot(record);
}

export function resolvePlanningExecutionContext(input: { runId?: string; clientSubmissionId?: string }): ExecutionSurfaceContext | undefined {
  const record = (input.runId ? contextsByRun.get(input.runId) : undefined) ?? (input.clientSubmissionId ? contextsBySubmission.get(input.clientSubmissionId) : undefined);
  return record ? snapshot(record) : undefined;
}

export function authorizePlanningOperation(context: ExecutionSurfaceContext | undefined, input: { operation: PlanningOperationName; todo?: PlanningTodo; todoId?: string; scope?: PlanningGrantScope; targetWorkspaceId?: string | null; toolCallId?: string }): void {
  if (!context) throw new Error("Planning Todo requires a trusted execution surface");
  const record = resolveRecord(context);
  const now = Date.now();
  for (const token of record.planningScopeGrants) {
    const grant = record.grants.get(token);
    if (!grant || grant.expiresAt <= now || grant.runId !== record.runId && record.runId !== undefined) continue;
    if (!grant.allowedOperations.includes(input.operation)) continue;
    if (input.scope && !grantAllowsScope(grant, input)) continue;
    const targetWorkspaceId = input.targetWorkspaceId !== undefined ? input.targetWorkspaceId ?? undefined : input.todo?.workspaceId;
    if (grant.workspaceId !== undefined && targetWorkspaceId !== grant.workspaceId) continue;
    if (grant.scope === "todo" && input.todoId && !(grant.todoIds ?? []).includes(input.todoId)) continue;
    if (grant.mode === "tool_call" && grant.toolCallId !== input.toolCallId) continue;
    if (grant.mode === "tool_call") {
      if (grant.consumed) continue;
      grant.consumed = true;
    }
    return;
  }
  throw new Error(`Planning Todo operation not authorized: ${input.operation}`);
}

function grantAllowsScope(grant: PlanningScopeGrant, input: { operation: PlanningOperationName; scope?: PlanningGrantScope; todo?: PlanningTodo; targetWorkspaceId?: string | null }): boolean {
  if (!input.scope || grant.scope === input.scope) return true;
  if (grant.scope === "all" && input.scope === "todo" && input.operation === "get") return true;
  if (input.scope !== "todo") return false;
  const targetWorkspaceId = input.targetWorkspaceId !== undefined ? input.targetWorkspaceId ?? undefined : input.todo?.workspaceId;
  if (grant.scope === "current") return Boolean(grant.workspaceId && targetWorkspaceId === grant.workspaceId);
  if (grant.scope === "unassigned") return targetWorkspaceId === undefined;
  return false;
}

export function finishPlanningExecutionRun(runId: string): void {
  const context = contextsByRun.get(runId);
  if (!context) return;
  for (const grant of context.grants.values()) grant.expiresAt = 0;
  contextsByRun.delete(runId);
  if (context.clientSubmissionId && contextsBySubmission.get(context.clientSubmissionId) === context) contextsBySubmission.delete(context.clientSubmissionId);
}

function resolveRecord(context: ExecutionSurfaceContext): ContextRecord {
  const record = (context.runId ? contextsByRun.get(context.runId) : undefined) ?? (context.clientSubmissionId ? contextsBySubmission.get(context.clientSubmissionId) : undefined);
  if (!record) throw new Error("planning execution context expired");
  return record;
}

function snapshot(context: ContextRecord): ExecutionSurfaceContext {
  return { surface: context.surface, threadId: context.threadId, ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}), ...(context.clientSubmissionId ? { clientSubmissionId: context.clientSubmissionId } : {}), ...(context.runId ? { runId: context.runId } : {}), ...(context.continuationOperationId ? { continuationOperationId: context.continuationOperationId } : {}), ...(context.globalPlanningRead ? { globalPlanningRead: true } : {}), planningScopeGrants: [...context.planningScopeGrants], authorizedTodoIds: [...context.authorizedTodoIds] };
}

export function planningSurfaceFromTrustedOrigin(origin: "main_window" | "quick_input"): PlanningExecutionSurface {
  return origin === "quick_input" ? "quick-input" : "main";
}

export type PlanningPrimaryRelation = PlanningTodoRelation;
export type PlanningContinuationKind = PlanningOperationKind;
