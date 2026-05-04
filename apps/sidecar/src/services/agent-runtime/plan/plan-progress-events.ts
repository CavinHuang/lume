import type { LumeRunEvent } from "@lume/shared";
import type { LumePlan, LumePlanEvent, LumePlanStep } from "./plan-types";

export function projectPlanToProgressEvents(plan: LumePlan): LumeRunEvent[] {
  return (plan.events ?? []).map((event) => projectPlanEventToProgressEvent(plan, event));
}

export function projectPlanEventToProgressEvent(plan: LumePlan, event: LumePlanEvent): LumeRunEvent {
  return {
    type: "plan_progress",
    planId: plan.id,
    status: plan.status,
    currentStepId: plan.currentStepId,
    steps: plan.steps,
    message: event.message ?? defaultPlanEventMessage(plan.steps, event),
    createdAt: event.createdAt
  };
}

function defaultPlanEventMessage(steps: LumePlanStep[], event: LumePlanEvent): string | undefined {
  if (!event.stepId) {
    if (event.type === "plan_started") return "开始执行计划";
    if (event.type === "plan_completed") return "计划执行完成";
    return undefined;
  }
  const step = steps.find((item) => item.id === event.stepId);
  return step?.title || step?.description || event.stepId;
}
