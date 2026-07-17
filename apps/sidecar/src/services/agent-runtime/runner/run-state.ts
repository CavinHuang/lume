import type {
  AgentMessageAttachmentInput,
  AgentTraceContext,
  FileReferenceBinding,
  RuntimeBillingUsageSummary,
  RuntimeUsageContextSnapshot
} from "@lume/shared";
import type { LumeInterruption } from "../interruption/interruption";
import type { LumeRunItem } from "./run-items";

export type LumeRunStatus =
  | "created"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_user"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type LumeRunStepType =
  | "prepare_context"
  | "input_guardrails"
  | "model_call"
  | "tool_approval"
  | "tool_call"
  | "tool_result"
  | "handoff"
  | "subagent"
  | "output_guardrails"
  | "persist_session"
  | "finalize";

export interface LumeRunStep {
  id: string;
  type: LumeRunStepType;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  endedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface LumeRunInput {
  userMessage: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  threadType?: string;
  chatType?: string;
  messageAttachments?: AgentMessageAttachmentInput[];
  messageMetadata?: Record<string, unknown>;
  traceContext?: AgentTraceContext;
}

export interface LumeApprovalState {
  alwaysAllowedTools: string[];
}

export interface LumeRunState {
  version: 1;
  runId: string;
  threadId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  fileReferenceBinding?: FileReferenceBinding;
  rootAgentId: string;
  currentAgentId: string;
  status: LumeRunStatus;
  currentStep?: LumeRunStep;
  input: LumeRunInput;
  generatedItems: LumeRunItem[];
  pendingInterruptions: LumeInterruption[];
  approvals: LumeApprovalState;
  contractId?: string;
  traceId: string;
  model: {
    provider: string;
    modelId: string;
    modelRef?: string;
    channelId?: string;
    contextWindow?: number;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUSD?: number;
    context?: RuntimeUsageContextSnapshot;
    billing?: RuntimeBillingUsageSummary;
  };
  error?: {
    code: string;
    message: string;
    stack?: string;
    retryable?: boolean;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export const ACTIVE_RUN_STATUSES = new Set<LumeRunStatus>([
  "created",
  "running",
  "waiting_for_approval",
  "waiting_for_user",
  "paused"
]);
