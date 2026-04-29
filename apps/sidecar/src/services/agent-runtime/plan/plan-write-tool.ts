import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@lume/agent-sdk";
import { createFileBackedLumePlanStore } from "./plan-store";
import type { LumePlan, LumePlanStep } from "./plan-types";

export interface CreatePlanWriteToolInput {
  sessionDir: string;
  threadId: string;
  runId: string;
  traceSpanId?: string;
  now?: () => string;
}

export function createPlanWriteTool(input: CreatePlanWriteToolInput): ToolDefinition {
  const now = input.now ?? (() => new Date().toISOString());
  const store = createFileBackedLumePlanStore(input.sessionDir);

  return defineTool({
    name: "PlanWrite",
    description: "Create or update a structured execution plan for the current Lume run.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        goal: { type: "string" },
        summary: { type: "string" },
        assumptions: { type: "array", items: { type: "string" } },
        questions: { type: "array" },
        risks: { type: "array" },
        steps: { type: "array" },
        expectedChanges: { type: "object" },
        status: { type: "string" },
        currentStepId: { type: "string" }
      },
      required: ["goal", "summary", "steps"]
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(rawInput) {
      const record = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
      const createdAt = now();
      const id = toNonEmptyString(record.id) ?? randomUUID();
      const existing = await store.get(id);
      const plan: LumePlan = {
        id,
        runId: input.runId,
        threadId: input.threadId,
        goal: toNonEmptyString(record.goal) ?? existing?.goal ?? "",
        summary: toNonEmptyString(record.summary) ?? existing?.summary ?? "",
        assumptions: toStringArray(record.assumptions) ?? existing?.assumptions ?? [],
        questions: Array.isArray(record.questions) ? record.questions as LumePlan["questions"] : existing?.questions ?? [],
        risks: Array.isArray(record.risks) ? record.risks as LumePlan["risks"] : existing?.risks ?? [],
        steps: normalizeSteps(record.steps, existing?.steps ?? []),
        expectedChanges: record.expectedChanges && typeof record.expectedChanges === "object"
          ? record.expectedChanges as LumePlan["expectedChanges"]
          : existing?.expectedChanges ?? {},
        status: normalizePlanStatus(record.status) ?? existing?.status ?? "draft",
        currentStepId: toNonEmptyString(record.currentStepId) ?? existing?.currentStepId,
        traceSpanId: input.traceSpanId ?? existing?.traceSpanId,
        createdAt: existing?.createdAt ?? createdAt,
        updatedAt: createdAt,
        approvedAt: existing?.approvedAt
      };
      await store.upsert(plan);
      return {
        data: {
          planId: plan.id,
          status: plan.status,
          stepCount: plan.steps.length
        }
      };
    }
  });
}

function normalizeSteps(value: unknown, fallback: LumePlanStep[]): LumePlanStep[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const title = toNonEmptyString(record.title);
      if (!title) return null;
      const expectedTools = toStringArray(record.expectedTools);
      const expectedFiles = toStringArray(record.expectedFiles);
      const traceSpanId = toNonEmptyString(record.traceSpanId);
      const currentStepId = toNonEmptyString(record.currentStepId);
      const result = toNonEmptyString(record.result);
      const error = toNonEmptyString(record.error);
      return {
        id: toNonEmptyString(record.id) ?? `step-${index + 1}`,
        title,
        description: toNonEmptyString(record.description) ?? title,
        type: normalizeStepType(record.type),
        status: normalizeStepStatus(record.status),
        ...(expectedTools ? { expectedTools } : {}),
        ...(expectedFiles ? { expectedFiles } : {}),
        ...(traceSpanId ? { traceSpanId } : {}),
        ...(currentStepId ? { currentStepId } : {}),
        ...(result ? { result } : {}),
        ...(error ? { error } : {})
      } satisfies LumePlanStep;
    })
    .filter((step): step is LumePlanStep => step !== null);
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeStepType(value: unknown): LumePlanStep["type"] {
  return value === "read"
    || value === "analyze"
    || value === "edit"
    || value === "execute"
    || value === "ask_user"
    || value === "memory"
    || value === "subagent"
    ? value
    : "analyze";
}

function normalizeStepStatus(value: unknown): LumePlanStep["status"] {
  return value === "running"
    || value === "completed"
    || value === "failed"
    || value === "skipped"
    ? value
    : "pending";
}

function normalizePlanStatus(value: unknown): LumePlan["status"] | undefined {
  return value === "draft"
    || value === "needs_user_input"
    || value === "needs_approval"
    || value === "approved"
    || value === "executing"
    || value === "completed"
    || value === "cancelled"
    || value === "failed"
    ? value
    : undefined;
}
