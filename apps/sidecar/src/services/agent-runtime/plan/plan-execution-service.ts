import type { LumePlan, LumePlanStep } from "./plan-types";
import { createFileBackedLumePlanStore } from "./plan-store";

export async function markStructuredPlanExecutionStarted(input: {
  sessionDir: string;
  threadId: string;
  stepText?: string;
}): Promise<LumePlan | null> {
  return updateLatestPlan(input.sessionDir, input.threadId, (plan) => {
    const currentStepId = plan.currentStepId ?? plan.steps.find((step) => step.status === "pending")?.id;
    if (!currentStepId) return null;
    const steps = plan.steps.map((step) => {
      if (step.id !== currentStepId) return step;
      return {
        ...step,
        ...(input.stepText ? { title: input.stepText, description: input.stepText } : {}),
        status: "running" as const,
        error: undefined
      };
    });
    return {
      ...plan,
      status: "executing",
      currentStepId,
      steps
    };
  });
}

export async function markStructuredPlanExecutionCompleted(input: {
  sessionDir: string;
  threadId: string;
  result?: string;
}): Promise<LumePlan | null> {
  return updateLatestPlan(input.sessionDir, input.threadId, (plan) => {
    const currentStepId = plan.currentStepId ?? plan.steps.find((step) => step.status === "running")?.id;
    if (!currentStepId) return null;
    const steps = plan.steps.map((step) => (
      step.id === currentStepId
        ? { ...step, status: "completed" as const, result: input.result ?? step.result, error: undefined }
        : step
    ));
    return {
      ...plan,
      status: steps.every((step) => step.status === "completed" || step.status === "skipped")
        ? "completed"
        : "approved",
      currentStepId: undefined,
      steps
    };
  });
}

export async function markStructuredPlanExecutionFailed(input: {
  sessionDir: string;
  threadId: string;
  error: string;
}): Promise<LumePlan | null> {
  return updateLatestPlan(input.sessionDir, input.threadId, (plan) => {
    const currentStepId = plan.currentStepId
      ?? plan.steps.find((step) => step.status === "running")?.id
      ?? plan.steps.find((step) => step.status === "pending")?.id;
    if (!currentStepId) return null;
    const steps = plan.steps.map((step) => (
      step.id === currentStepId
        ? { ...step, status: "failed" as const, error: input.error }
        : step
    ));
    return {
      ...plan,
      status: "failed",
      currentStepId,
      steps
    };
  });
}

async function updateLatestPlan(
  sessionDir: string,
  threadId: string,
  update: (plan: LumePlan) => Omit<LumePlan, "updatedAt"> | LumePlan | null
): Promise<LumePlan | null> {
  const store = createFileBackedLumePlanStore(sessionDir);
  const plan = (await store.listByThread(threadId))
    .filter((item) => item.steps.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!plan) return null;
  const next = update(plan);
  if (!next) return null;
  const saved: LumePlan = {
    ...next,
    updatedAt: new Date().toISOString()
  };
  await store.upsert(saved);
  return saved;
}
