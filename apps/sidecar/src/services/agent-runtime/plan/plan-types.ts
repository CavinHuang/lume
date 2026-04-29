export type LumePlanStatus =
  | "draft"
  | "needs_user_input"
  | "needs_approval"
  | "approved"
  | "executing"
  | "completed"
  | "cancelled"
  | "failed";

export interface LumePlanQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface LumePlanRisk {
  id: string;
  description: string;
  severity?: "low" | "medium" | "high";
}

export interface LumePlanStep {
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
}

export interface LumePlan {
  id: string;
  runId: string;
  threadId: string;
  goal: string;
  summary: string;
  assumptions: string[];
  questions: LumePlanQuestion[];
  risks: LumePlanRisk[];
  steps: LumePlanStep[];
  expectedChanges: {
    files?: string[];
    commands?: string[];
    tools?: string[];
    memoryWrites?: string[];
  };
  status: LumePlanStatus;
  currentStepId?: string;
  traceSpanId?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
