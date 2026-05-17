export type AgentLoopPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

export interface AgentLoopInput {
  threadId: string;
  runId: string;
  userMessage: string;
  workspaceId?: string;
  workspaceSlug?: string;
  threadType?: "direct" | "subagent" | string;
  chatType?: "direct" | "automation" | string;
  permissionMode?: AgentLoopPermissionMode;
  model: {
    provider: string;
    modelId: string;
    modelRef?: string;
    channelId?: string;
    contextWindow?: number;
    maxTokens?: number;
  };
  messageMetadata?: Record<string, unknown>;
  runtimeOptions?: {
    maxTurns?: number;
    includePartialMessages?: boolean;
    resume?: boolean;
  };
}

export type AgentLoopExitStatus =
  | "completed"
  | "turn_limited"
  | "cancelled"
  | "failed"
  | "waiting_for_user"
  | "waiting_for_approval";

export interface AgentLoopResult {
  runId: string;
  threadId: string;
  status: AgentLoopExitStatus;
  finalOutput?: string;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}
