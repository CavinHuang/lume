import type { TaskContractRecord } from "./task-contract-record-types";
import { createFileBackedTaskContractStore } from "./task-contract-store";

export async function markTaskContractFallbackExecutionFailed(input: {
  sessionDir: string;
  threadId: string;
  error: string;
}): Promise<TaskContractRecord | null> {
  return updateLatestTaskContract(input.sessionDir, input.threadId, (contract) => {
    const currentStepId = contract.currentStepId
      ?? contract.steps.find((step) => step.status === "running")?.id
      ?? contract.steps.find((step) => step.status === "pending")?.id;
    if (!currentStepId) return null;
    const steps = contract.steps.map((step) => (
      step.id === currentStepId
        ? { ...step, status: "failed" as const, error: input.error }
        : step
    ));
    return {
      ...contract,
      status: "failed",
      currentStepId,
      steps
    };
  });
}

export async function markTaskContractFallbackExecutionWaiting(input: {
  sessionDir: string;
  threadId: string;
  status: "needs_user_input" | "needs_approval";
  reason?: string;
}): Promise<TaskContractRecord | null> {
  return updateLatestTaskContract(input.sessionDir, input.threadId, (contract) => {
    const currentStepId = contract.currentStepId
      ?? contract.steps.find((step) => step.status === "running")?.id
      ?? contract.steps.find((step) => step.status === "pending")?.id;
    return {
      ...contract,
      status: input.status,
      currentStepId,
      steps: contract.steps.map((step) => (
        step.id === currentStepId && input.reason
          ? { ...step, result: input.reason, blockedReason: input.reason }
          : step
      )),
      events: currentStepId
        ? [
            ...(contract.events ?? []),
            {
              type: "contract_waiting" as const,
              contractId: contract.id,
              taskId: currentStepId,
              message: input.reason,
              createdAt: new Date().toISOString()
            }
          ]
        : contract.events
    };
  });
}

export async function markTaskContractInteractionResolved(input: {
  sessionDir: string;
  threadId: string;
}): Promise<TaskContractRecord | null> {
  return updateLatestTaskContract(input.sessionDir, input.threadId, (contract) => {
    if (contract.status !== "needs_user_input" && contract.status !== "needs_approval") {
      return null;
    }
    return {
      ...contract,
      status: "approved"
    };
  });
}

async function updateLatestTaskContract(
  sessionDir: string,
  threadId: string,
  update: (contract: TaskContractRecord) => Omit<TaskContractRecord, "updatedAt"> | TaskContractRecord | null
): Promise<TaskContractRecord | null> {
  const store = createFileBackedTaskContractStore(sessionDir);
  const contract = (await store.listByThread(threadId))
    .filter((item) => item.steps.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!contract) return null;
  const next = update(contract);
  if (!next) return null;
  const saved: TaskContractRecord = {
    ...next,
    updatedAt: new Date().toISOString()
  };
  await store.upsert(saved);
  return saved;
}
