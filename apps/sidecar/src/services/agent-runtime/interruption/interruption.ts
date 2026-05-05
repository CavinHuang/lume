export type LumeInterruptionType =
  | "tool_approval"
  | "ask_user"
  | "task_approval"
  | "memory_approval"
  | "automation_approval"
  | "subagent_approval";

export interface LumeInterruptionOption {
  id: string;
  label: string;
  description?: string;
}

export interface LumeInterruption {
  id: string;
  runId?: string;
  threadId: string;
  originThreadId?: string;
  type: LumeInterruptionType;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  title: string;
  message: string;
  payload: unknown;
  source: {
    agentId?: string;
    toolName?: string;
    toolCallId?: string;
    subagentRunId?: string;
    subagentLabel?: string;
  };
  options?: LumeInterruptionOption[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolution?: {
    decision: "approve" | "reject" | "answer";
    answer?: unknown;
    rememberDecision?: boolean;
    message?: string;
  };
}
