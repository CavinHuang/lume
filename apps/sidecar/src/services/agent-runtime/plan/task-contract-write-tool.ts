import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@lume/agent-sdk";
import {
  normalizeThreadPlanFilePath,
  readThreadPlanMarkdownFile,
  verifyThreadPlanMarkdownFile,
  writeThreadPlanMarkdownFile
} from "./plan-markdown-file-service";
import { persistTaskApprovalInterruption } from "./task-approval-service";
import { createFileBackedTaskContractStore } from "./task-contract-store";
import type { TaskContractRecord, TaskContractRecordItem } from "./task-contract-record-types";

export interface CreateTaskContractWriteToolInput {
  sessionDir: string;
  threadId: string;
  runId: string;
  threadWorkspaceDir?: string;
  now?: () => string;
  onTaskContractUpdated?: (contract: TaskContractRecord, preview?: TaskContractPlanPreview) => void | Promise<void>;
}

export interface TaskContractPlanPreview {
  contractId: string;
  title: string;
  summary: string;
  markdown: string;
  planFilePath?: string;
  planVerified?: boolean;
  stepCount: number;
}

export function createTaskContractWriteTool(input: CreateTaskContractWriteToolInput): ToolDefinition {
  const now = input.now ?? (() => new Date().toISOString());
  const store = createFileBackedTaskContractStore(input.sessionDir);

  return defineTool({
    name: "TaskContractWrite",
    description: `Create or update a reviewable Markdown plan draft for the current Lume run.

IMPORTANT: Before setting status to "needs_approval", you MUST provide a detailed Markdown plan via planMarkdown. Lume will write it to the thread workspace at:
  plans/{contractId}.md

TaskContractWrite stores the task contract for review, but does not create an executable task run while the plan is pending review. Lume creates the task run only after the user approves the plan.

The plan document should include:
- YAML frontmatter with contractId and status: draft
- # Goal section
- ## Steps section with numbered items
- ## Risks & Assumptions section

If you provide planFilePath, it must be a thread-workspace relative path. Do not pass an absolute path.`,
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
        planFilePath: { type: "string" },
        planMarkdown: { type: "string" }
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
      const planMarkdown = toMarkdownString(record.planMarkdown);
      const status = normalizeTaskContractStatus(record.status) ?? existing?.status ?? "draft";
      const planFilePath = planMarkdown && input.threadWorkspaceDir
        ? writeThreadPlanMarkdownFile({
            threadWorkspaceDir: input.threadWorkspaceDir,
            contractId: id,
            markdown: planMarkdown,
            planFilePath: record.planFilePath
          })
        : normalizeThreadPlanFilePath(record.planFilePath, existing?.planFilePath);
      const planVerification = resolvePlanVerification({
        status,
        threadWorkspaceDir: input.threadWorkspaceDir,
        planFilePath,
        existingVerification: existing?.planVerification,
        now
      });
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
        status,
        planFilePath,
        planVerification,
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
      await input.onTaskContractUpdated?.(contract, buildTaskContractPlanPreview({
        contract,
        threadWorkspaceDir: input.threadWorkspaceDir
      }));
      return {
        data: {
          contractId: contract.id,
          status: contract.status,
          stepCount: contract.steps.length,
          ...(contract.planFilePath ? { planFilePath: contract.planFilePath } : {}),
          ...(contract.planVerification ? { planVerified: contract.planVerification.verified } : {})
        }
      };
    }
  });
}

function buildTaskContractPlanPreview(input: {
  contract: TaskContractRecord;
  threadWorkspaceDir?: string;
}): TaskContractPlanPreview | undefined {
  if (input.contract.status !== "needs_approval") {
    return undefined;
  }
  if (!input.threadWorkspaceDir || !input.contract.planFilePath || input.contract.planVerification?.verified !== true) {
    return undefined;
  }
  return {
    contractId: input.contract.id,
    title: input.contract.goal,
    summary: input.contract.summary,
    markdown: readThreadPlanMarkdownFile({
      threadWorkspaceDir: input.threadWorkspaceDir,
      planFilePath: input.contract.planFilePath
    }),
    planFilePath: input.contract.planFilePath,
    planVerified: true,
    stepCount: input.contract.steps.length
  };
}

function resolvePlanVerification(input: {
  status: TaskContractRecord["status"];
  threadWorkspaceDir?: string;
  planFilePath?: string;
  existingVerification?: TaskContractRecord["planVerification"];
  now: () => string;
}): TaskContractRecord["planVerification"] {
  if (input.status !== "needs_approval") {
    return input.existingVerification;
  }
  if (!input.threadWorkspaceDir || !input.planFilePath) {
    throw new Error("提交审批前必须生成并验证 Markdown 计划文件");
  }
  return verifyThreadPlanMarkdownFile({
    threadWorkspaceDir: input.threadWorkspaceDir,
    planFilePath: input.planFilePath,
    now: input.now
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

function toMarkdownString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
    || value === "needs_approval"
    || value === "approved"
    || value === "cancelled"
    ? value
    : undefined;
}
