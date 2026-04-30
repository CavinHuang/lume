import type { LumeInterruption } from "../interruption/interruption";
import { createFileBackedLumeInterruptionStore } from "../interruption/interruption-store";
import type { AgentPlanApprovalRequest } from "@lume/shared";
import { listPendingRuntimeCoreInterruptionRecords } from "../interruption/interruption-index";
import type { LumePlan } from "./plan-types";
import { createFileBackedLumePlanStore } from "./plan-store";

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

export async function listPendingPlanApprovalRequests(sessionDir?: string): Promise<AgentPlanApprovalRequest[]> {
  const records = sessionDir
    ? (await createFileBackedLumeInterruptionStore(sessionDir).listPending()).map((interruption) => ({
        sessionDir,
        interruption
      }))
    : listPendingRuntimeCoreInterruptionRecords();
  const requests: AgentPlanApprovalRequest[] = [];

  for (const record of records) {
    if (record.interruption.type !== "plan_approval") continue;
    const payload = record.interruption.payload as { planId?: string; stepCount?: number; expectedChanges?: LumePlan["expectedChanges"] };
    const planId = payload?.planId;
    if (!planId) continue;
    const plan = await createFileBackedLumePlanStore(record.sessionDir).get(planId);
    requests.push({
      threadId: record.interruption.threadId,
      runId: record.interruption.runId,
      requestId: record.interruption.id,
      planId,
      title: record.interruption.title,
      message: record.interruption.message,
      summary: plan?.summary,
      stepCount: plan?.steps.length ?? payload.stepCount ?? 0,
      expectedChanges: plan?.expectedChanges ?? payload.expectedChanges
    });
  }

  return requests;
}

export async function resolvePlanApproval(input: {
  sessionDir: string;
  threadId: string;
  planId: string;
  decision: "approve" | "reject";
}): Promise<boolean> {
  const store = createFileBackedLumeInterruptionStore(input.sessionDir);
  const interruption = await store.get(planApprovalInterruptionId(input.planId));
  if (!interruption || interruption.threadId !== input.threadId || interruption.status !== "pending") {
    return false;
  }

  const approved = input.decision === "approve";
  await store.resolve(interruption.id, {
    status: approved ? "approved" : "rejected",
    resolution: { decision: approved ? "approve" : "reject" }
  });

  const planStore = createFileBackedLumePlanStore(input.sessionDir);
  const plan = await planStore.get(input.planId);
  if (plan) {
    await planStore.upsert({
      ...plan,
      status: approved ? "approved" : "cancelled",
      approvedAt: approved ? new Date().toISOString() : plan.approvedAt,
      updatedAt: new Date().toISOString()
    });
  }

  return true;
}
