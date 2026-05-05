import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@lume/agent-sdk";
import { persistTaskApprovalInterruption } from "./task-approval-service";
import { createFileBackedTaskContractStore } from "./task-contract-store";
import type { TaskContractRecord, TaskContractRecordItem } from "./task-contract-record-types";

export interface CreateTaskContractWriteToolInput {
  sessionDir: string;
  threadId: string;
  runId: string;
  traceSpanId?: string;
  now?: () => string;
  onTaskContractUpdated?: (contract: TaskContractRecord) => void | Promise<void>;
}

export function createTaskContractWriteTool(input: CreateTaskContractWriteToolInput): ToolDefinition {
  const now = input.now ?? (() => new Date().toISOString());
  const store = createFileBackedTaskContractStore(input.sessionDir);

  return defineTool({
    name: "TaskContractWrite",
    description: "Create or update an approvable task contract for the current Lume run.",
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
    isReadOnly: true,
    isConcurrencySafe: false,
    async call(rawInput) {
      const record = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
      const createdAt = now();
      const id = toNonEmptyString(record.id) ?? randomUUID();
      const existing = await store.get(id);
      const contract: TaskContractRecord = {
        id,
        runId: input.runId,
        threadId: input.threadId,
        goal: toNonEmptyString(record.goal) ?? existing?.goal ?? "",
        summary: toNonEmptyString(record.summary) ?? existing?.summary ?? "",
        assumptions: toStringArray(record.assumptions) ?? existing?.assumptions ?? [],
        questions: Array.isArray(record.questions) ? record.questions as TaskContractRecord["questions"] : existing?.questions ?? [],
        risks: Array.isArray(record.risks) ? record.risks as TaskContractRecord["risks"] : existing?.risks ?? [],
        steps: normalizeSteps(record.steps, existing?.steps ?? []),
        expectedChanges: record.expectedChanges && typeof record.expectedChanges === "object"
          ? record.expectedChanges as TaskContractRecord["expectedChanges"]
          : existing?.expectedChanges ?? {},
        status: normalizeTaskContractStatus(record.status) ?? existing?.status ?? "draft",
        traceSpanId: input.traceSpanId ?? existing?.traceSpanId,
        createdAt: existing?.createdAt ?? createdAt,
        updatedAt: createdAt,
        approvedAt: existing?.approvedAt
      };
      await store.upsert(contract);
      if (contract.status === "needs_approval") {
        await persistTaskApprovalInterruption({
          sessionDir: input.sessionDir,
          contract
        });
      }
      await input.onTaskContractUpdated?.(contract);
      return {
        data: {
          contractId: contract.id,
          status: contract.status,
          stepCount: contract.steps.length
        }
      };
    }
  });
}

function normalizeSteps(value: unknown, fallback: TaskContractRecordItem[]): TaskContractRecordItem[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((item, index): TaskContractRecordItem | null => {
      if (typeof item === "string" && item.trim()) {
        return {
          id: `step-${index + 1}`,
          title: item.trim(),
          description: item.trim(),
          type: "analyze" as const,
          status: "pending" as const
        } satisfies TaskContractRecordItem;
      }
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const title = toNonEmptyString(record.title)
        ?? toNonEmptyString(record.text)
        ?? toNonEmptyString(record.description);
      if (!title) return null;
      const expectedTools = toStringArray(record.expectedTools);
      const expectedFiles = toStringArray(record.expectedFiles);
      return {
        id: toNonEmptyString(record.id) ?? `step-${index + 1}`,
        title,
        description: toNonEmptyString(record.description) ?? title,
        type: normalizeStepType(record.type),
        status: "pending" as const,
        ...(expectedTools ? { expectedTools } : {}),
        ...(expectedFiles ? { expectedFiles } : {})
      } satisfies TaskContractRecordItem;
    })
    .filter((step): step is TaskContractRecordItem => step !== null);
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeStepType(value: unknown): TaskContractRecordItem["type"] {
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

function normalizeTaskContractStatus(value: unknown): TaskContractRecord["status"] | undefined {
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
