import type { LumeInterruption } from "../interruption/interruption";
import { createFileBackedLumeInterruptionStore } from "../interruption/interruption-store";
import type { AgentTaskApprovalRequest } from "@lume/shared";
import { listPendingRuntimeCoreInterruptionRecords } from "../interruption/interruption-index";
import type { TaskContractRecord } from "./task-contract-record-types";
import { createFileBackedTaskContractStore } from "./task-contract-store";

interface TaskApprovalPayload {
  contractId?: string;
  stepCount?: number;
  expectedChanges?: TaskContractRecord["expectedChanges"];
  summary?: string;
  planFilePath?: string;
  planVerified?: boolean;
  contract?: TaskContractRecord;
}

export function taskApprovalInterruptionId(contractId: string): string {
  return `task_approval:${contractId}`;
}

export async function persistTaskApprovalInterruption(input: {
  sessionDir: string;
  contract: TaskContractRecord;
  message?: string;
}): Promise<LumeInterruption> {
  const now = new Date().toISOString();
  const interruption: LumeInterruption = {
    id: taskApprovalInterruptionId(input.contract.id),
    runId: input.contract.runId,
    threadId: input.contract.threadId,
    type: "task_approval",
    status: "pending",
    title: "审阅计划",
    message: input.message ?? input.contract.summary,
    payload: {
      contractId: input.contract.id,
      stepCount: input.contract.steps.length,
      expectedChanges: input.contract.expectedChanges,
      summary: input.contract.summary,
      ...(input.contract.planFilePath ? { planFilePath: input.contract.planFilePath } : {}),
      ...(input.contract.planVerification ? { planVerified: input.contract.planVerification.verified } : {}),
      contract: input.contract
    },
    source: {},
    createdAt: now,
    updatedAt: now
  };
  await createFileBackedLumeInterruptionStore(input.sessionDir).upsert(interruption);
  return interruption;
}

export async function listPendingTaskApprovalRequests(sessionDir?: string): Promise<AgentTaskApprovalRequest[]> {
  const records = sessionDir
    ? (await createFileBackedLumeInterruptionStore(sessionDir).listPending()).map((interruption) => ({
        sessionDir,
        interruption
      }))
    : listPendingRuntimeCoreInterruptionRecords();
  const requests: AgentTaskApprovalRequest[] = [];

  for (const record of records) {
    if (record.interruption.type !== "task_approval") continue;
    const payload = record.interruption.payload as TaskApprovalPayload;
    const contractId = payload?.contractId;
    if (!contractId) continue;
    const storedContract = await createFileBackedTaskContractStore(record.sessionDir).get(contractId);
    const contract = storedContract ?? payload.contract;
    requests.push({
      threadId: record.interruption.threadId,
      runId: record.interruption.runId,
      requestId: record.interruption.id,
      contractId,
      title: record.interruption.title,
      message: record.interruption.message,
      summary: contract?.summary ?? payload.summary,
      stepCount: contract?.steps.length ?? payload.stepCount ?? 0,
      expectedChanges: contract?.expectedChanges ?? payload.expectedChanges,
      ...(contract?.planFilePath ?? payload.planFilePath
        ? {
            planFilePath: contract?.planFilePath ?? payload.planFilePath,
            planVerified: contract?.planVerification?.verified === true || payload.planVerified === true
          }
        : {})
    });
  }

  return requests;
}

export async function resolveTaskApproval(input: {
  sessionDir: string;
  threadId: string;
  contractId: string;
  decision: "approve" | "reject";
}): Promise<boolean> {
  const store = createFileBackedLumeInterruptionStore(input.sessionDir);
  const interruption = await store.get(taskApprovalInterruptionId(input.contractId));
  if (!interruption || interruption.threadId !== input.threadId || interruption.status !== "pending") {
    return false;
  }

  const approved = input.decision === "approve";
  const contractStore = createFileBackedTaskContractStore(input.sessionDir);
  const storedContract = await contractStore.get(input.contractId);
  const payload = interruption.payload as TaskApprovalPayload;
  const contract = storedContract ?? payload.contract;
  const timestamp = new Date().toISOString();

  if (approved && !contract) {
    return false;
  }

  if (approved && contract) {
    await contractStore.upsert({
      ...contract,
      status: "approved",
      approvedAt: timestamp,
      updatedAt: timestamp
    });
  } else if (!approved && storedContract) {
    await contractStore.upsert({
      ...storedContract,
      status: "cancelled",
      updatedAt: timestamp
    });
  }

  await store.resolve(interruption.id, {
    status: approved ? "approved" : "rejected",
    resolution: { decision: approved ? "approve" : "reject" }
  });

  return true;
}
