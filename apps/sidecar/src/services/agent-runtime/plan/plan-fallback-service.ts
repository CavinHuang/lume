import { randomUUID } from "node:crypto";
import { persistPlanApprovalInterruption } from "./plan-approval-service";
import { createFileBackedLumePlanStore } from "./plan-store";
import type { LumePlan, LumePlanStep } from "./plan-types";

export async function persistFallbackPlanFromText(input: {
  sessionDir: string;
  threadId: string;
  runId: string;
  text: string;
  now?: () => string;
  onPlanUpdated?: (plan: LumePlan) => void | Promise<void>;
}): Promise<LumePlan | null> {
  const text = input.text.trim();
  if (!text) return null;
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const plan: LumePlan = {
    id: randomUUID(),
    runId: input.runId,
    threadId: input.threadId,
    goal: inferGoal(text),
    summary: inferSummary(text),
    assumptions: [],
    questions: [],
    risks: [],
    steps: inferSteps(text),
    expectedChanges: {},
    status: "needs_approval",
    createdAt,
    updatedAt: createdAt
  };

  await createFileBackedLumePlanStore(input.sessionDir).upsert(plan);
  await persistPlanApprovalInterruption({
    sessionDir: input.sessionDir,
    plan,
    message: "Agent 未调用 PlanWrite；Lume 已将回复内容整理为待审批计划。"
  });
  await input.onPlanUpdated?.(plan);
  return plan;
}

function inferGoal(text: string): string {
  const title = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0 && line.length <= 80);
  return title ?? "执行当前计划";
}

function inferSummary(text: string): string {
  const paragraph = text
    .replace(/^#+\s*/gm, "")
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!paragraph) return "根据 agent 的计划回复生成的待审批计划。";
  return paragraph.length > 240 ? `${paragraph.slice(0, 237)}...` : paragraph;
}

function inferSteps(text: string): LumePlanStep[] {
  const steps = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:\d+[.)、]|[-*•])\s+(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));

  const uniqueSteps = Array.from(new Set(steps)).slice(0, 12);
  const finalSteps = uniqueSteps.length > 0 ? uniqueSteps : ["根据计划文本完成调研与整理"];
  return finalSteps.map((title, index) => ({
    id: `step-${index + 1}`,
    title,
    description: title,
    type: "analyze",
    status: "pending"
  }));
}
