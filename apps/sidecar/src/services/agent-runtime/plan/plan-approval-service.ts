import type { LumeInterruption } from "../interruption/interruption";
import { createFileBackedLumeInterruptionStore } from "../interruption/interruption-store";
import type { LumePlan } from "./plan-types";

export function planApprovalInterruptionId(planId: string): string {
  return `plan_approval:${planId}`;
}

export async function persistPlanApprovalInterruption(input: {
  sessionDir: string;
  plan: LumePlan;
  message?: string;
}): Promise<LumeInterruption> {
  const now = new Date().toISOString();
  const interruption: LumeInterruption = {
    id: planApprovalInterruptionId(input.plan.id),
    runId: input.plan.runId,
    threadId: input.plan.threadId,
    type: "plan_approval",
    status: "pending",
    title: "确认执行计划",
    message: input.message ?? input.plan.summary,
    payload: {
      planId: input.plan.id,
      stepCount: input.plan.steps.length,
      expectedChanges: input.plan.expectedChanges
    },
    source: {},
    createdAt: now,
    updatedAt: now
  };
  await createFileBackedLumeInterruptionStore(input.sessionDir).upsert(interruption);
  return interruption;
}
