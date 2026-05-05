import type { TaskContractTask } from "../plan/task-contract-types";

export type TaskRunStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskRunTaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface TaskRunTask extends TaskContractTask {
  status: TaskRunTaskStatus;
  attemptCount: number;
  result?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  blockedReason?: string;
}

export interface TaskRunEvent {
  type:
    | "task_run_created"
    | "task_started"
    | "task_completed"
    | "task_failed"
    | "task_skipped"
    | "task_waiting"
    | "task_run_completed";
  taskRunId: string;
  contractId?: string;
  taskId?: string;
  message?: string;
  createdAt: string;
}

export interface TaskRun {
  id: string;
  contractId: string;
  runId: string;
  threadId: string;
  goal: string;
  summary: string;
  status: TaskRunStatus;
  currentTaskId?: string;
  tasks: TaskRunTask[];
  events: TaskRunEvent[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
