import type { AgentMessageAttachmentInput } from "./agent";

export type RuntimeEventType =
  | "run.started"
  | "run.completed"
  | "run.turn_limited"
  | "run.failed"
  | "run.cancelled"
  | "message.user.submitted"
  | "assistant.delta"
  | "assistant.thinking_delta"
  | "assistant.final"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "tool.permission_timeout"
  | "plan.preview"
  | "task.progress"
  | "permission.requested"
  | "ask_user.requested"
  | "memory.context.used"
  | "context.compaction.started"
  | "context.compaction.completed"
  | "usage.updated";

export interface RuntimeEventBase {
  id: string;
  type: RuntimeEventType;
  threadId: string;
  runId: string;
  createdAt: string;
  sequence?: number;
  subagentRunId?: string;
  parentToolUseId?: string;
}

export interface ContextBudgetRuntimeSnapshot {
  totalTokens: number;
  usedTokens: number;
  remainingTokens: number;
  sections: {
    system?: number;
    memory?: number;
    session?: number;
    toolSchemas?: number;
    reservedOutput?: number;
  };
}

export interface RunStartedRuntimeEvent extends RuntimeEventBase {
  type: "run.started";
  workspaceId?: string;
  workspaceSlug?: string;
  model?: {
    provider: string;
    modelId: string;
    modelRef?: string;
    channelId?: string;
    contextWindow?: number;
  };
}

export interface UserMessageSubmittedRuntimeEvent extends RuntimeEventBase {
  type: "message.user.submitted";
  text: string;
  attachments?: AgentMessageAttachmentInput[];
  messageId?: string;
  versionGroupId?: string;
  versionIndex?: number;
  versionCount?: number;
}

export interface AssistantDeltaRuntimeEvent extends RuntimeEventBase {
  type: "assistant.delta";
  delta: string;
  messageId?: string;
}

export interface AssistantThinkingDeltaRuntimeEvent extends RuntimeEventBase {
  type: "assistant.thinking_delta";
  delta: string;
  messageId?: string;
}

export interface AssistantFinalRuntimeEvent extends RuntimeEventBase {
  type: "assistant.final";
  blocks: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
  >;
}

export interface ToolStartedRuntimeEvent extends RuntimeEventBase {
  type: "tool.started";
  toolCallId: string;
  toolName: string;
  inputPreview?: unknown;
  riskLevel?: "low" | "medium" | "high";
}

export interface ToolCompletedRuntimeEvent extends RuntimeEventBase {
  type: "tool.completed";
  toolCallId: string;
  toolName?: string;
  resultPreview?: string;
  resultRef?: {
    kind: "file";
    path: string;
    size: number;
    mimeType?: string;
  };
}

export interface ToolFailedRuntimeEvent extends RuntimeEventBase {
  type: "tool.failed";
  toolCallId: string;
  toolName?: string;
  error: {
    code: string;
    message: string;
  };
}

export interface ToolPermissionTimeoutRuntimeEvent extends RuntimeEventBase {
  type: "tool.permission_timeout";
  toolCallId: string;
  requestId: string;
  toolName: string;
  message: string;
}

export interface PlanPreviewRuntimeEvent extends RuntimeEventBase {
  type: "plan.preview";
  contractId: string;
  title: string;
  summary: string;
  markdown: string;
  planFilePath?: string;
  planVerified?: boolean;
  stepCount: number;
}

export type TaskProgressRuntimeStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskProgressRuntimeTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface TaskProgressRuntimeTask {
  id: string;
  title: string;
  description?: string;
  expectedTools?: string[];
  expectedFiles?: string[];
  status: TaskProgressRuntimeTaskStatus;
  attemptCount: number;
  result?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  blockedReason?: string;
}

export interface TaskProgressRuntimeEvent extends RuntimeEventBase {
  type: "task.progress";
  taskRunId: string;
  contractId: string;
  status: TaskProgressRuntimeStatus;
  currentTaskId?: string;
  tasks: TaskProgressRuntimeTask[];
  message?: string;
}

export interface RunCompletedRuntimeEvent extends RuntimeEventBase {
  type: "run.completed";
  finalOutput?: string;
  finalMessageId?: string;
}

export interface RunTurnLimitedRuntimeEvent extends RuntimeEventBase {
  type: "run.turn_limited";
  reason?: string;
}

export interface RunFailedRuntimeEvent extends RuntimeEventBase {
  type: "run.failed";
  error: {
    code: string;
    message: string;
    stack?: string;
    retryable?: boolean;
  };
}

export interface RunCancelledRuntimeEvent extends RuntimeEventBase {
  type: "run.cancelled";
  reason?: string;
}

export interface ContextCompactionStartedRuntimeEvent extends RuntimeEventBase {
  type: "context.compaction.started";
  trigger: "auto" | "manual" | "prompt_too_long" | string;
  preTokens: number;
  contextWindow?: number;
  budget?: ContextBudgetRuntimeSnapshot;
  policy: string;
  source: string;
}

export interface MemoryContextUsedRuntimeEvent extends RuntimeEventBase {
  type: "memory.context.used";
  messageId?: string;
  items: Array<{
    id: string;
    kind: "preference" | "fact" | "decision" | "lesson" | "state";
    scope: "global" | "workspace";
    status: "active" | "suspected_stale";
    citation: string;
    reason: string;
  }>;
  hidden?: boolean;
}

export interface ContextCompactionCompletedRuntimeEvent extends RuntimeEventBase {
  type: "context.compaction.completed";
  trigger: "auto" | "manual" | "prompt_too_long" | string;
  preTokens: number;
  postTokens?: number;
  contextWindow?: number;
  budget?: ContextBudgetRuntimeSnapshot;
  policy: string;
  source: string;
  summary?: string;
}

export interface UsageUpdatedRuntimeEvent extends RuntimeEventBase {
  type: "usage.updated";
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  usageRecords?: Array<{
    callerLabel: string;
    model?: string;
    turn?: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    costUSD?: number;
  }>;
  totalTokens: number;
  contextWindow?: number;
  costUSD?: number;
}

export type LumeRuntimeEvent =
  | RunStartedRuntimeEvent
  | UserMessageSubmittedRuntimeEvent
  | AssistantDeltaRuntimeEvent
  | AssistantThinkingDeltaRuntimeEvent
  | AssistantFinalRuntimeEvent
  | ToolStartedRuntimeEvent
  | ToolCompletedRuntimeEvent
  | ToolFailedRuntimeEvent
  | ToolPermissionTimeoutRuntimeEvent
  | PlanPreviewRuntimeEvent
  | TaskProgressRuntimeEvent
  | RunCompletedRuntimeEvent
  | RunTurnLimitedRuntimeEvent
  | RunFailedRuntimeEvent
  | RunCancelledRuntimeEvent
  | MemoryContextUsedRuntimeEvent
  | ContextCompactionStartedRuntimeEvent
  | ContextCompactionCompletedRuntimeEvent
  | UsageUpdatedRuntimeEvent;
