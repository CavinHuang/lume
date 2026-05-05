export type TaskContractStatus = "draft" | "needs_approval" | "approved" | "rejected";

export interface TaskContractTask {
  id: string;
  title: string;
  description?: string;
  expectedTools?: string[];
  expectedFiles?: string[];
}

export interface TaskContractRisk {
  id: string;
  description: string;
  severity?: "low" | "medium" | "high";
}

export interface TaskContract {
  id: string;
  runId: string;
  threadId: string;
  goal: string;
  summary: string;
  tasks: TaskContractTask[];
  risks: TaskContractRisk[];
  expectedChanges: {
    files?: string[];
    commands?: string[];
    tools?: string[];
    memoryWrites?: string[];
  };
  status: TaskContractStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
