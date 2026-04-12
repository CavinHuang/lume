export const SUBAGENT_RUN_STORE_VERSION = 1 as const;

export type SubagentRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "errored"
  | "aborted"
  | "timed_out"
  | "canceled";

export interface SubagentRunOutcome {
  output?: string;
  error?: string;
  errorCode?: string;
  usageEvents?: number;
}

export interface SubagentRun {
  runId: string;
  parentThreadId: string;
  parentRunId?: string;
  rootThreadId: string;
  depth: number;
  childThreadId: string;
  deliveryThreadId?: string;
  threadRequested?: boolean;
  threadBound?: boolean;
  label?: string;
  task: string;
  status: SubagentRunStatus;
  cleanup: "keep" | "delete";
  parentToolUseId?: string;
  requestedAgentId?: string;
  resolvedAgentId?: string;
  modelRef?: string;
  channelId?: string;
  modelId?: string;
  announceStatus?: "pending" | "delivered" | "failed";
  announceAttempts?: number;
  announceLastError?: string;
  announceDeliveredAt?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
}

export interface SubagentRunStoreSchema {
  version: typeof SUBAGENT_RUN_STORE_VERSION;
  runs: SubagentRun[];
}

export interface CreateSubagentRunInput {
  runId: string;
  parentThreadId: string;
  parentRunId?: string;
  rootThreadId?: string;
  depth?: number;
  childThreadId: string;
  deliveryThreadId?: string;
  threadRequested?: boolean;
  threadBound?: boolean;
  label?: string;
  task: string;
  cleanup: "keep" | "delete";
  status?: SubagentRunStatus;
  parentToolUseId?: string;
  requestedAgentId?: string;
  resolvedAgentId?: string;
  modelRef?: string;
  channelId?: string;
  modelId?: string;
  announceStatus?: "pending" | "delivered" | "failed";
  announceAttempts?: number;
  announceLastError?: string;
  announceDeliveredAt?: number;
  createdAt?: number;
}

export interface UpdateSubagentRunInput {
  status?: SubagentRunStatus;
  cleanup?: "keep" | "delete";
  modelRef?: string;
  channelId?: string;
  modelId?: string;
  deliveryThreadId?: string;
  threadRequested?: boolean;
  threadBound?: boolean;
  requestedAgentId?: string;
  resolvedAgentId?: string;
  parentToolUseId?: string;
  announceStatus?: "pending" | "delivered" | "failed";
  announceAttempts?: number;
  announceLastError?: string;
  announceDeliveredAt?: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
}

