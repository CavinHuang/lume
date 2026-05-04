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
  attemptCount?: number;
  startedAt?: string;
  endedAt?: string;
  blockedReason?: string;
}

export interface LumePlanEvent {
  type:
    | "plan_started"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "step_skipped"
    | "plan_waiting"
    | "plan_completed";
  planId: string;
  stepId?: string;
  message?: string;
  createdAt: string;
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
  events?: LumePlanEvent[];
  status: LumePlanStatus;
  currentStepId?: string;
  traceSpanId?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
