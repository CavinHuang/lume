import type { LumeInterruption } from "../interruption/interruption";
import { createFileBackedLumeInterruptionStore } from "../interruption/interruption-store";
import type { AgentTaskApprovalRequest } from "@lume/shared";
import { listPendingRuntimeCoreInterruptionRecords } from "../interruption/interruption-index";
import type { TaskContractRecord } from "./task-contract-record-types";
import { createFileBackedTaskContractStore } from "./task-contract-store";

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
    title: "确认任务清单",
    message: input.message ?? input.contract.summary,
    payload: {
      contractId: input.contract.id,
      stepCount: input.contract.steps.length,
      expectedChanges: input.contract.expectedChanges
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
    const payload = record.interruption.payload as { contractId?: string; stepCount?: number; expectedChanges?: TaskContractRecord["expectedChanges"] };
    const contractId = payload?.contractId;
    if (!contractId) continue;
    const contract = await createFileBackedTaskContractStore(record.sessionDir).get(contractId);
    requests.push({
      threadId: record.interruption.threadId,
      runId: record.interruption.runId,
      requestId: record.interruption.id,
      contractId,
      title: record.interruption.title,
      message: record.interruption.message,
      summary: contract?.summary,
      stepCount: contract?.steps.length ?? payload.stepCount ?? 0,
      expectedChanges: contract?.expectedChanges ?? payload.expectedChanges,
      planFilePath: contract?.planFilePath
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
  await store.resolve(interruption.id, {
    status: approved ? "approved" : "rejected",
    resolution: { decision: approved ? "approve" : "reject" }
  });

  const contractStore = createFileBackedTaskContractStore(input.sessionDir);
  const contract = await contractStore.get(input.contractId);
  if (contract) {
    await contractStore.upsert({
      ...contract,
      status: approved ? "approved" : "cancelled",
      approvedAt: approved ? new Date().toISOString() : contract.approvedAt,
      updatedAt: new Date().toISOString()
    });
  }

  return true;
}
