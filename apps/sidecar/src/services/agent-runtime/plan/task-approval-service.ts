import type { LumeInterruption } from "../interruption/interruption";
import { createFileBackedLumeInterruptionStore } from "../interruption/interruption-store";
import type { AgentTaskApprovalRequest } from "@lume/shared";
import { listPendingRuntimeCoreInterruptionRecords } from "../interruption/interruption-index";
import type { TaskContractRecord } from "./task-contract-record-types";
import { createFileBackedTaskContractStore } from "./task-contract-store";

interface TaskApprovalPayload {
  contractId?: string;
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
    message: input.message ?? "审阅任务计划",
    payload: {
      contractId: input.contract.id
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
    const contract = await createFileBackedTaskContractStore(record.sessionDir).get(contractId);
    if (!contract) continue;
    requests.push({
      threadId: record.interruption.threadId,
      runId: record.interruption.runId,
      requestId: record.interruption.id,
      contractId,
      title: record.interruption.title,
      message: record.interruption.message,
      summary: contract.summary,
      stepCount: contract.steps.length,
      expectedChanges: contract.expectedChanges,
      ...(contract.planFilePath
        ? {
            planFilePath: contract.planFilePath,
            planVerified: contract.planVerification?.verified === true
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
  const contract = await contractStore.get(input.contractId);
  const timestamp = new Date().toISOString();

  if (!contract) {
    return false;
  }

  if (approved) {
    await contractStore.upsert({
      ...contract,
      status: "approved",
      approvedAt: timestamp,
      updatedAt: timestamp
    });
  } else {
    await contractStore.upsert({
      ...contract,
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
