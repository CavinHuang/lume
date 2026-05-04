import type { LumePlan, LumePlanStep } from "./plan-types";
import { createFileBackedLumePlanStore } from "./plan-store";
import type { AgentSendInput } from "@lume/shared";

export function buildPlanContinuationSendInput(input: {
  threadId: string;
  userMessage: string;
  plan: LumePlan;
  permissionMode?: AgentSendInput["permissionMode"];
}): AgentSendInput | null {
  return buildPlanExecutionSendInput({
    threadId: input.threadId,
    plan: input.plan,
    permissionMode: input.permissionMode,
    controlEvent: "continue_plan"
  });
}

export function buildPlanExecutionSendInput(input: {
  threadId: string;
  plan: LumePlan;
  permissionMode?: AgentSendInput["permissionMode"];
  controlEvent?: "execute_plan" | "continue_plan";
}): AgentSendInput | null {
  const remainingSteps = input.plan.steps.filter((step) => (
    step.status === "pending" || step.status === "running" || step.status === "failed"
  ));
  if (remainingSteps.length === 0) return null;
  const stepTexts = remainingSteps.map(formatPlanStepText);
  return {
    threadId: input.threadId,
    userMessage: [
      input.controlEvent === "continue_plan"
        ? "请按顺序自动继续执行当前未完成计划。"
        : "请按顺序自动执行已批准计划的全部剩余任务。",
      input.plan.summary ? `计划摘要：${input.plan.summary}` : "",
      `执行步骤：\n${stepTexts.map((text, index) => `${index + 1}. ${text}`).join("\n")}`,
      "执行过程中请按计划逐项推进；遇到阻塞再询问我。"
    ].filter(Boolean).join("\n\n"),
    permissionMode: input.permissionMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits",
    messageMetadata: {
      hiddenFromChat: true,
      planControlEvent: input.controlEvent ?? "execute_plan",
      planExecutionKey: input.plan.id,
      planExecutionMode: "all",
      planExecutionSteps: stepTexts
    }
  };
}

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
  completeAll?: boolean;
}): Promise<LumePlan | null> {
  return updateLatestPlan(input.sessionDir, input.threadId, (plan) => {
    if (input.completeAll) {
      return {
        ...plan,
        status: "completed",
        currentStepId: undefined,
        steps: plan.steps.map((step) => (
          step.status === "skipped"
            ? step
            : { ...step, status: "completed" as const, result: input.result ?? step.result, error: undefined }
        ))
      };
    }
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

export async function markStructuredPlanExecutionWaiting(input: {
  sessionDir: string;
  threadId: string;
  status: "needs_user_input" | "needs_approval";
  reason?: string;
}): Promise<LumePlan | null> {
  return updateLatestPlan(input.sessionDir, input.threadId, (plan) => {
    const currentStepId = plan.currentStepId
      ?? plan.steps.find((step) => step.status === "running")?.id
      ?? plan.steps.find((step) => step.status === "pending")?.id;
    return {
      ...plan,
      status: input.status,
      currentStepId,
      steps: plan.steps.map((step) => (
        step.id === currentStepId && input.reason
          ? { ...step, result: input.reason, blockedReason: input.reason }
          : step
      )),
      events: currentStepId
        ? [
            ...(plan.events ?? []),
            {
              type: "plan_waiting" as const,
              planId: plan.id,
              stepId: currentStepId,
              message: input.reason,
              createdAt: new Date().toISOString()
            }
          ]
        : plan.events
    };
  });
}

export async function markStructuredPlanInteractionResolved(input: {
  sessionDir: string;
  threadId: string;
}): Promise<LumePlan | null> {
  return updateLatestPlan(input.sessionDir, input.threadId, (plan) => {
    if (plan.status !== "needs_user_input" && plan.status !== "needs_approval") {
      return null;
    }
    return {
      ...plan,
      status: "approved"
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

function formatPlanStepText(step: LumePlanStep): string {
  return step.title || step.description || `执行计划步骤 ${step.id}`;
}
