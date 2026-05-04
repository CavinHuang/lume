import type { AgentSendInput } from "@lume/shared";
import { createFileBackedLumePlanStore } from "./plan-store";
import type { LumePlan, LumePlanEvent, LumePlanStep } from "./plan-types";

export type PlanExecutionIntent = "execute" | "continue" | "retry" | "skip";

export interface StartedPlanStep {
  plan: LumePlan;
  step: LumePlanStep;
}

export function buildCurrentPlanStepSendInput(input: {
  threadId: string;
  plan: LumePlan;
  step: LumePlanStep;
  permissionMode?: AgentSendInput["permissionMode"];
  controlEvent?: "execute_plan_step" | "continue_plan_step" | "retry_plan_step";
}): AgentSendInput {
  return {
    threadId: input.threadId,
    userMessage: [
      "请只执行当前计划步骤，不要执行其它步骤。",
      `计划 ID：${input.plan.id}`,
      `步骤 ID：${input.step.id}`,
      input.plan.summary ? `计划摘要：${input.plan.summary}` : "",
      `当前步骤：${formatPlanStepText(input.step)}`,
      "完成、失败或被阻塞时，必须调用 PlanStepUpdate 写入结构化步骤结果。",
      "不要只在普通回复里描述结果；没有 PlanStepUpdate 的运行会被视为该步骤失败。"
    ].filter(Boolean).join("\n\n"),
    permissionMode: input.permissionMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits",
    messageMetadata: {
      hiddenFromChat: true,
      planControlEvent: input.controlEvent ?? "execute_plan_step",
      planExecutionKey: input.plan.id,
      planExecutionMode: "step",
      planExecutionStepId: input.step.id
    }
  };
}

export async function startNextPlanStep(input: {
  sessionDir: string;
  threadId: string;
  planId?: string;
  intent?: PlanExecutionIntent;
  now?: () => string;
}): Promise<StartedPlanStep | null> {
  if (input.intent === "skip") {
    await skipCurrentPlanStep(input);
  }
  const now = input.now ?? (() => new Date().toISOString());
  const store = createFileBackedLumePlanStore(input.sessionDir);
  const plan = await resolvePlan(store, input.threadId, input.planId);
  if (!plan) return null;
  if (!isPlanExecutable(plan)) return null;

  const step = selectNextStep(plan, input.intent ?? "execute");
  if (!step) {
    const completed = await completePlanIfDone(input.sessionDir, plan, now());
    return completed ? null : null;
  }

  const timestamp = now();
  const alreadyStarted = (plan.events ?? []).some((event) => event.type === "plan_started");
  const steps = plan.steps.map((item) => {
    if (item.id !== step.id) return item;
    return {
      ...item,
      status: "running" as const,
      error: undefined,
      blockedReason: undefined,
      attemptCount: (item.attemptCount ?? 0) + 1,
      startedAt: timestamp,
      endedAt: undefined
    };
  });
  const saved: LumePlan = {
    ...plan,
    status: "executing",
    currentStepId: step.id,
    steps,
    events: [
      ...(plan.events ?? []),
      ...(alreadyStarted ? [] : [planEvent("plan_started", plan.id, timestamp)]),
      planEvent("step_started", plan.id, timestamp, step.id)
    ],
    updatedAt: timestamp
  };
  await store.upsert(saved);
  return {
    plan: saved,
    step: saved.steps.find((item) => item.id === step.id) ?? step
  };
}

export async function markCurrentPlanStepUnreported(input: {
  sessionDir: string;
  threadId: string;
  planId?: string;
  now?: () => string;
}): Promise<LumePlan | null> {
  return updateCurrentStep(input, {
    status: "failed",
    message: "步骤未提交结构化结果",
    now: input.now
  });
}

export async function skipCurrentPlanStep(input: {
  sessionDir: string;
  threadId: string;
  planId?: string;
  now?: () => string;
}): Promise<LumePlan | null> {
  const now = input.now ?? (() => new Date().toISOString());
  const store = createFileBackedLumePlanStore(input.sessionDir);
  const plan = await resolvePlan(store, input.threadId, input.planId);
  if (!plan) return null;
  const step = plan.currentStepId
    ? plan.steps.find((item) => item.id === plan.currentStepId)
    : plan.steps.find((item) => item.status === "failed" || item.status === "pending");
  if (!step || step.status === "running" || step.status === "completed" || step.status === "skipped") {
    return null;
  }
  const timestamp = now();
  const steps = plan.steps.map((item) => (
    item.id === step.id
      ? { ...item, status: "skipped" as const, error: undefined, endedAt: timestamp }
      : item
  ));
  const nextStatus = steps.every((item) => item.status === "completed" || item.status === "skipped")
    ? "completed"
    : "approved";
  const events: LumePlanEvent[] = [
    ...(plan.events ?? []),
    planEvent("step_skipped", plan.id, timestamp, step.id, "已跳过计划步骤"),
    ...(nextStatus === "completed" ? [planEvent("plan_completed", plan.id, timestamp)] : [])
  ];
  const saved: LumePlan = {
    ...plan,
    status: nextStatus,
    currentStepId: undefined,
    steps,
    events,
    updatedAt: timestamp
  };
  await store.upsert(saved);
  return saved;
}

export async function updateCurrentStep(input: {
  sessionDir: string;
  threadId: string;
  planId?: string;
}, update: {
  stepId?: string;
  status: "completed" | "failed" | "blocked";
  message?: string;
  now?: () => string;
}): Promise<LumePlan | null> {
  const now = update.now ?? (() => new Date().toISOString());
  const store = createFileBackedLumePlanStore(input.sessionDir);
  const plan = await resolvePlan(store, input.threadId, input.planId);
  if (!plan || !plan.currentStepId) return null;
  if (update.stepId && update.stepId !== plan.currentStepId) {
    throw new Error("只能更新当前正在执行的计划步骤");
  }
  const currentStep = plan.steps.find((step) => step.id === plan.currentStepId);
  if (!currentStep || currentStep.status !== "running") {
    throw new Error("只能更新当前正在执行的计划步骤");
  }
  const timestamp = now();

  if (update.status === "blocked") {
    const steps = plan.steps.map((step) => (
      step.id === currentStep.id
        ? { ...step, blockedReason: update.message, result: update.message }
        : step
    ));
    const saved: LumePlan = {
      ...plan,
      status: "needs_user_input",
      steps,
      events: [
        ...(plan.events ?? []),
        planEvent("plan_waiting", plan.id, timestamp, currentStep.id, update.message ?? "计划步骤被阻塞")
      ],
      updatedAt: timestamp
    };
    await store.upsert(saved);
    return saved;
  }

  const stepStatus: LumePlanStep["status"] = update.status === "completed" ? "completed" : "failed";
  const steps: LumePlanStep[] = plan.steps.map((step) => {
    if (step.id !== currentStep.id) return step;
    return {
      ...step,
      status: stepStatus,
      result: update.status === "completed" ? update.message : step.result,
      error: update.status === "failed" ? update.message : undefined,
      endedAt: timestamp,
      blockedReason: undefined
    };
  });
  const hasRemaining = steps.some((step) => step.status === "pending" || step.status === "failed");
  const nextStatus = update.status === "failed"
    ? "failed"
    : hasRemaining
      ? "approved"
      : "completed";
  const events: LumePlanEvent[] = [
    ...(plan.events ?? []),
    planEvent(update.status === "completed" ? "step_completed" : "step_failed", plan.id, timestamp, currentStep.id, update.message),
    ...(nextStatus === "completed" ? [planEvent("plan_completed", plan.id, timestamp)] : [])
  ];
  const saved: LumePlan = {
    ...plan,
    status: nextStatus,
    currentStepId: update.status === "failed" ? currentStep.id : undefined,
    steps,
    events,
    updatedAt: timestamp
  };
  await store.upsert(saved);
  return saved;
}

async function completePlanIfDone(sessionDir: string, plan: LumePlan, timestamp: string): Promise<LumePlan | null> {
  if (!plan.steps.every((step) => step.status === "completed" || step.status === "skipped")) return null;
  const store = createFileBackedLumePlanStore(sessionDir);
  const saved: LumePlan = {
    ...plan,
    status: "completed",
    currentStepId: undefined,
    events: [...(plan.events ?? []), planEvent("plan_completed", plan.id, timestamp)],
    updatedAt: timestamp
  };
  await store.upsert(saved);
  return saved;
}

async function resolvePlan(
  store: ReturnType<typeof createFileBackedLumePlanStore>,
  threadId: string,
  planId?: string
): Promise<LumePlan | null> {
  if (planId) {
    const plan = await store.get(planId);
    return plan?.threadId === threadId ? plan : null;
  }
  return (await store.listByThread(threadId))
    .filter((item) => item.steps.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

function isPlanExecutable(plan: LumePlan): boolean {
  return plan.status === "approved" || plan.status === "executing" || plan.status === "failed";
}

function selectNextStep(plan: LumePlan, intent: PlanExecutionIntent): LumePlanStep | null {
  if (intent === "retry" && plan.currentStepId) {
    const current = plan.steps.find((step) => step.id === plan.currentStepId);
    if (current?.status === "failed") return current;
  }
  if (plan.currentStepId) {
    const current = plan.steps.find((step) => step.id === plan.currentStepId);
    if (current?.status === "running") return current;
  }
  return plan.steps.find((step) => step.status === "pending" || step.status === "failed") ?? null;
}

function planEvent(
  type: LumePlanEvent["type"],
  planId: string,
  createdAt: string,
  stepId?: string,
  message?: string
): LumePlanEvent {
  return {
    type,
    planId,
    ...(stepId ? { stepId } : {}),
    ...(message ? { message } : {}),
    createdAt
  };
}

function formatPlanStepText(step: LumePlanStep): string {
  return step.title || step.description || `执行计划步骤 ${step.id}`;
}
