import type {
  AgentSendInput,
  AgentThreadMessageDispatchResult,
  LumeRuntimeEvent
} from "@lume/shared";
import type { TaskContractRecord } from "./plan/task-contract-record-types";
import type { TaskContract } from "./plan/task-contract-types";
import { createFileBackedTaskContractStore } from "./plan/task-contract-store";
import { projectTaskRunEventToRuntimeEvent } from "./task-run/task-progress-events";
import {
  buildCurrentTaskRunSendInput,
  createTaskRunFromContract,
  markCurrentTaskUnreported,
  markTaskRunWaiting,
  skipCurrentTask,
  startNextTaskRunTask
} from "./task-run/task-run-controller";
import { createFileBackedTaskRunStore } from "./task-run/task-run-store";
import type { TaskRun } from "./task-run/task-run-types";

type PlanExecutionIntent = "execute" | "continue" | "retry" | "skip";
type PlanModePhase = "idle" | "planning" | "awaiting_approval" | "executing" | "completed";

export interface RuntimeOrchestrator {
  resolveExecutableTaskContract(input: { threadId: string; contractId?: string }): Promise<TaskContractRecord | null>;
  dispatchTaskExecution(input: {
    threadId: string;
    contractId?: string;
    permissionMode?: AgentSendInput["permissionMode"];
    intent?: PlanExecutionIntent;
  }): Promise<{
    ok: boolean;
    status: "sent" | "queued" | "not_found" | "not_executable";
    queuedCount?: number;
    contractId?: string;
    error?: string;
  }>;
  handleTaskRunCompletion(input: {
    threadId: string;
    taskRunId: string;
    contractId?: string;
    turnLimited: boolean;
  }): Promise<void>;
  setTaskRunAwaitingInteraction(input: {
    threadId: string;
    taskRunId: string;
    waitingFor: "user" | "permission";
    reason: string;
  }): Promise<void>;
}

export function createRuntimeOrchestrator<TEmitter>(deps: {
  appendAgentMessage: (
    input: AgentSendInput,
    emit: TEmitter,
    options?: { onExecutionStarted?: () => void }
  ) => AgentThreadMessageDispatchResult;
  createAgentStreamEmitter: (threadId: string, options?: { contractId?: string; taskRunId?: string }) => TEmitter;
  notifyPlanModePhaseChange: (threadId: string, phase: PlanModePhase) => void;
  resolveRuntimeSessionDir: (threadId: string) => string;
  writeRuntimeEvent: (threadId: string, event: LumeRuntimeEvent) => void;
}): RuntimeOrchestrator {
  const resolveExecutableTaskContract = async (input: { threadId: string; contractId?: string }) => {
    const contracts = await createFileBackedTaskContractStore(deps.resolveRuntimeSessionDir(input.threadId))
      .listByThread(input.threadId);
    const candidates = input.contractId
      ? contracts.filter((contract) => contract.id === input.contractId)
      : contracts
        .filter((contract) => contract.status === "approved" || contract.status === "executing" || contract.status === "failed")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return candidates[0] ?? null;
  };

  const emitLatestTaskProgress = (threadId: string, taskRun: TaskRun | null) => {
    if (!taskRun) return;
    const latestEvent = taskRun.events.at(-1);
    if (!latestEvent) return;
    deps.writeRuntimeEvent(threadId, projectTaskRunEventToRuntimeEvent(threadId, taskRun, latestEvent));
  };

  const dispatchTaskExecution: RuntimeOrchestrator["dispatchTaskExecution"] = async (input) => {
    const sessionDir = deps.resolveRuntimeSessionDir(input.threadId);
    const contract = await resolveExecutableTaskContract({ threadId: input.threadId, contractId: input.contractId });
    if (!contract) {
      return {
        ok: false,
        status: "not_found",
        error: "找不到可执行任务。"
      };
    }
    if (contract.status !== "approved" && contract.status !== "executing" && contract.status !== "failed") {
      return {
        ok: false,
        status: "not_executable",
        contractId: contract.id,
        error: "任务清单尚未批准或不可继续执行。"
      };
    }
    if (input.intent === "skip") {
      const taskRun = await createTaskRunFromTaskContractRecord(sessionDir, contract);
      const skipped = await skipCurrentTask({
        sessionDir,
        threadId: input.threadId,
        taskRunId: taskRun.id
      });
      if (skipped) {
        emitLatestTaskProgress(input.threadId, skipped);
        deps.notifyPlanModePhaseChange(input.threadId, skipped.status === "completed" ? "completed" : "executing");
      }
      return {
        ok: Boolean(skipped),
        status: skipped ? "sent" : "not_executable",
        contractId: contract.id,
        ...(skipped ? {} : { error: "当前任务不可跳过。" })
      };
    }
    const taskRun = await createTaskRunFromTaskContractRecord(sessionDir, contract);
    const started = await startNextTaskRunTask({
      sessionDir,
      threadId: input.threadId,
      taskRunId: taskRun.id,
      intent: input.intent ?? "execute"
    });
    if (!started) {
      return {
        ok: false,
        status: "not_executable",
        contractId: contract.id,
        error: "任务清单没有剩余可执行任务。"
      };
    }
    const sendInput = buildCurrentTaskRunSendInput({
      threadId: input.threadId,
      taskRun: started.taskRun,
      task: started.task,
      permissionMode: input.permissionMode ?? "acceptEdits",
      controlEvent: input.intent === "retry" ? "retry_task" : input.intent === "continue" ? "continue_task" : "execute_task"
    });
    emitLatestTaskProgress(input.threadId, started.taskRun);
    const dispatch = deps.appendAgentMessage(
      sendInput,
      deps.createAgentStreamEmitter(sendInput.threadId, { taskRunId: started.taskRun.id, contractId: contract.id }),
      {
        onExecutionStarted: () => {
          deps.notifyPlanModePhaseChange(input.threadId, "executing");
        }
      }
    );
    return {
      ok: true,
      status: dispatch.mode,
      queuedCount: dispatch.queuedCount,
      contractId: contract.id
    };
  };

  return {
    resolveExecutableTaskContract,
    dispatchTaskExecution,
    async handleTaskRunCompletion(input) {
      const sessionDir = deps.resolveRuntimeSessionDir(input.threadId);
      const store = createFileBackedTaskRunStore(sessionDir);
      let taskRun = await store.get(input.taskRunId);
      if (!input.turnLimited && taskRun?.status === "running" && taskRun.currentTaskId) {
        const current = taskRun.tasks.find((task) => task.id === taskRun?.currentTaskId);
        if (current?.status === "running") {
          taskRun = await markCurrentTaskUnreported({
            sessionDir,
            threadId: input.threadId,
            taskRunId: input.taskRunId
          });
        }
      }
      emitLatestTaskProgress(input.threadId, taskRun);
      if (taskRun?.status === "pending") {
        void dispatchTaskExecution({
          threadId: input.threadId,
          contractId: input.contractId,
          intent: "continue"
        });
        return;
      }
      if (taskRun?.status === "completed") {
        deps.notifyPlanModePhaseChange(input.threadId, "completed");
      }
    },
    async setTaskRunAwaitingInteraction(input) {
      const taskRun = await markTaskRunWaiting({
        sessionDir: deps.resolveRuntimeSessionDir(input.threadId),
        threadId: input.threadId,
        taskRunId: input.taskRunId,
        waitingFor: input.waitingFor,
        reason: input.reason
      });
      emitLatestTaskProgress(input.threadId, taskRun);
    }
  };
}

function taskContractRecordToTaskContract(contract: TaskContractRecord): TaskContract {
  return {
    id: contract.id,
    runId: contract.runId,
    threadId: contract.threadId,
    goal: contract.goal,
    summary: contract.summary,
    tasks: contract.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      ...(step.expectedTools ? { expectedTools: step.expectedTools } : {}),
      ...(step.expectedFiles ? { expectedFiles: step.expectedFiles } : {})
    })),
    risks: contract.risks,
    expectedChanges: contract.expectedChanges,
    status: contract.status === "approved" ? "approved" : contract.status === "cancelled" ? "rejected" : "draft",
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
    ...(contract.approvedAt ? { approvedAt: contract.approvedAt } : {})
  };
}

async function createTaskRunFromTaskContractRecord(sessionDir: string, contract: TaskContractRecord): Promise<TaskRun> {
  const store = createFileBackedTaskRunStore(sessionDir);
  const existing = await store.get(`taskrun-${contract.id}`);
  if (existing) return existing;
  const created = await createTaskRunFromContract({
    sessionDir,
    contract: taskContractRecordToTaskContract(contract)
  });
  const tasks = created.tasks.map((task) => {
    const step = contract.steps.find((item) => item.id === task.id);
    if (!step) return task;
    return {
      ...task,
      status: step.status === "running" ? "running" as const : step.status,
      attemptCount: step.attemptCount ?? task.attemptCount,
      ...(step.result ? { result: step.result } : {}),
      ...(step.error ? { error: step.error } : {}),
      ...(step.startedAt ? { startedAt: step.startedAt } : {}),
      ...(step.endedAt ? { endedAt: step.endedAt } : {}),
      ...(step.blockedReason ? { blockedReason: step.blockedReason } : {})
    };
  });
  const saved: TaskRun = {
    ...created,
    status: contract.status === "failed"
      ? "failed"
      : contract.status === "executing"
        ? "running"
        : contract.status === "completed"
          ? "completed"
          : "pending",
    currentTaskId: contract.currentStepId,
    tasks
  };
  await store.upsert(saved);
  return saved;
}
