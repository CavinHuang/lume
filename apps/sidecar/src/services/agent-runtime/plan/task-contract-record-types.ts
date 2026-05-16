export type TaskContractRecordStatus =
  | "draft"
  | "needs_approval"
  | "approved"
  | "cancelled";

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
  status: "pending";
  expectedTools?: string[];
  expectedFiles?: string[];
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
  status: TaskContractRecordStatus;
  createdAt: string;
  updatedAt: string;
  planFilePath?: string;
  planVerification?: {
    verified: boolean;
    planFilePath: string;
    bytes: number;
    checkedAt: string;
  };
  approvedAt?: string;
}
