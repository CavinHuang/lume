import { basename } from "node:path";
import type { PlanStep } from "@lume/shared";
import type { LumePlan, LumePlanStatus, LumePlanStep } from "./plan-types";
import type { LumePlanStore } from "./plan-store";

interface MarkdownPlanInput {
  runId: string;
  threadId: string;
  content: string;
  path?: string;
  createdAt?: string;
}

interface PlanStateStepsInput {
  runId: string;
  threadId: string;
  steps: PlanStep[];
  goal?: string;
  summary?: string;
  planPath?: string;
  createdAt?: string;
}

const VALID_PLAN_STATUSES = new Set<LumePlanStatus>([
  "draft",
  "needs_user_input",
  "needs_approval",
  "approved",
  "executing",
  "completed",
  "cancelled",
  "failed"
]);

export function mapMarkdownPlanToLumePlan(input: MarkdownPlanInput): LumePlan {
  const { frontmatter, body } = parseFrontmatter(input.content);
  const now = input.createdAt ?? new Date().toISOString();
  const id = readString(frontmatter.slug)
    || readString(frontmatter.id)
    || derivePlanId(input.path, input.threadId, now);
  const title = firstHeading(body) || readString(frontmatter.title) || "Execution plan";
  const summary = readString(frontmatter.summary) || firstParagraph(body) || title;
  const status = normalizePlanStatus(readString(frontmatter.status));

  return {
    id,
    runId: input.runId,
    threadId: input.threadId,
    goal: title,
    summary,
    assumptions: [],
    questions: [],
    risks: [],
    steps: extractSteps(body),
    expectedChanges: {
      ...(input.path ? { files: [input.path] } : {})
    },
    status,
    createdAt: now,
    updatedAt: now,
    ...(status === "approved" ? { approvedAt: now } : {})
  };
}

export async function importMarkdownPlan(
  store: LumePlanStore,
  input: MarkdownPlanInput
): Promise<LumePlan> {
  const plan = mapMarkdownPlanToLumePlan(input);
  await store.upsert(plan);
  return plan;
}

export function mapPlanStateStepsToLumePlan(input: PlanStateStepsInput): LumePlan {
  const now = input.createdAt ?? new Date().toISOString();
  const steps = input.steps.map((step, index): LumePlanStep => ({
    id: step.id || `step-${index + 1}`,
    title: step.text,
    description: step.text,
    type: inferStepType(step.text),
    status: mapPlanStepStatus(step.status),
    ...(step.lastError ? { error: step.lastError } : {})
  }));
  const hasRunning = steps.some((step) => step.status === "running");
  const hasFailed = steps.some((step) => step.status === "failed");
  const allCompleted = steps.length > 0 && steps.every((step) => step.status === "completed");
  const status: LumePlanStatus = hasFailed
    ? "failed"
    : hasRunning
      ? "executing"
      : allCompleted
        ? "completed"
        : "approved";

  return {
    id: derivePlanId(input.planPath, input.threadId, now),
    runId: input.runId,
    threadId: input.threadId,
    goal: input.goal ?? "Execute approved plan",
    summary: input.summary ?? input.goal ?? "Execute approved plan",
    assumptions: [],
    questions: [],
    risks: [],
    steps,
    expectedChanges: {
      ...(input.planPath ? { files: [input.planPath] } : {})
    },
    status,
    createdAt: now,
    updatedAt: now,
    ...(status === "approved" || status === "executing" || status === "completed" ? { approvedAt: now } : {})
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const frontmatter: Record<string, unknown> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    frontmatter[key] = rawValue.replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: content.slice(match[0].length).trim() };
}

function firstHeading(body: string): string | undefined {
  const heading = body.split("\n")
    .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
    .find((value) => !!value);
  return heading || undefined;
}

function firstParagraph(body: string): string | undefined {
  return body.split(/\n{2,}/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith("#") && !isStepLine(part));
}

function extractSteps(body: string): LumePlanStep[] {
  const steps: LumePlanStep[] = [];
  for (const line of body.split("\n")) {
    const taskMatch = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+?)\s*$/);
    const rawTitle = taskMatch?.[2] ?? orderedMatch?.[1];
    if (!rawTitle) continue;
    const title = rawTitle.trim();
    if (!title) continue;
    steps.push({
      id: `step-${steps.length + 1}`,
      title,
      description: title,
      type: inferStepType(title),
      status: taskMatch?.[1]?.toLowerCase() === "x" ? "completed" : "pending"
    });
  }
  return steps;
}

function isStepLine(value: string): boolean {
  return /^\s*[-*]\s+\[[ xX]\]\s+/.test(value) || /^\s*\d+[.)]\s+/.test(value);
}

function inferStepType(title: string): LumePlanStep["type"] {
  const normalized = title.toLowerCase();
  if (/ask|question|确认|提问/.test(normalized)) return "ask_user";
  if (/edit|write|implement|修改|实现|写入/.test(normalized)) return "edit";
  if (/test|run|execute|执行|验证/.test(normalized)) return "execute";
  if (/read|inspect|查看|读取/.test(normalized)) return "read";
  return "analyze";
}

function normalizePlanStatus(value: string | undefined): LumePlanStatus {
  return value && VALID_PLAN_STATUSES.has(value as LumePlanStatus)
    ? value as LumePlanStatus
    : "draft";
}

function mapPlanStepStatus(status: PlanStep["status"]): LumePlanStep["status"] {
  if (status === "in_progress") return "running";
  return status;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function derivePlanId(path: string | undefined, threadId: string, createdAt: string): string {
  const name = path ? basename(path).replace(/\.[^.]+$/, "") : "";
  return (name || `${threadId}-${createdAt}`).replace(/[^a-zA-Z0-9._:-]/g, "_");
}
