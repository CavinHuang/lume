export type TaskContractRecordStatus =
  | "draft"
  | "needs_user_input"
  | "needs_approval"
  | "approved"
  | "executing"
  | "completed"
  | "cancelled"
  | "failed";

export interface TaskContractQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface TaskContractRiskRecord {
  id: string;
  description: string;
  severity?: "low" | "medium" | "high";
}

export interface TaskContractRecordItem {
  id: string;
  title: string;
  description: string;
  type: "read" | "analyze" | "edit" | "execute" | "ask_user" | "memory" | "subagent";
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  expectedTools?: string[];
  expectedFiles?: string[];
  traceSpanId?: string;
  currentStepId?: string;
  result?: string;
  error?: string;
  attemptCount?: number;
  startedAt?: string;
  endedAt?: string;
  blockedReason?: string;
}

export interface TaskContractRecordEvent {
  type:
    | "contract_started"
    | "task_started"
    | "task_completed"
    | "task_failed"
    | "task_skipped"
    | "contract_waiting"
    | "contract_completed";
  contractId: string;
  taskId?: string;
  message?: string;
  createdAt: string;
}

export interface TaskContractRecord {
  id: string;
  runId: string;
  threadId: string;
  goal: string;
  summary: string;
  assumptions: string[];
  questions: TaskContractQuestion[];
  risks: TaskContractRiskRecord[];
  steps: TaskContractRecordItem[];
  expectedChanges: {
    files?: string[];
    commands?: string[];
    tools?: string[];
    memoryWrites?: string[];
  };
  events?: TaskContractRecordEvent[];
  status: TaskContractRecordStatus;
  currentStepId?: string;
  traceSpanId?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
