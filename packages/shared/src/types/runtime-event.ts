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
  | "task.progress"
  | "permission.requested"
  | "ask_user.requested"
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
  };
}

export interface UserMessageSubmittedRuntimeEvent extends RuntimeEventBase {
  type: "message.user.submitted";
  text: string;
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

export type LumeRuntimeEvent =
  | RunStartedRuntimeEvent
  | UserMessageSubmittedRuntimeEvent
  | AssistantDeltaRuntimeEvent
  | AssistantThinkingDeltaRuntimeEvent
  | AssistantFinalRuntimeEvent
  | ToolStartedRuntimeEvent
  | ToolCompletedRuntimeEvent
  | ToolFailedRuntimeEvent
  | TaskProgressRuntimeEvent
  | RunCompletedRuntimeEvent
  | RunTurnLimitedRuntimeEvent
  | RunFailedRuntimeEvent
  | RunCancelledRuntimeEvent;
