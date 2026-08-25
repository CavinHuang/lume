export type RunContinuationStatus =
  | "waiting_for_interruption"
  | "ready_to_execute"
  | "tool_running"
  | "waiting_background"
  | "ready_to_resume"
  | "resumed"
  | "interrupted"
  | "failed"
  | "not_resumable";

export type RunContinuationToolKind =
  | "read"
  | "write"
  | "execute"
  | "control"
  | "network"
  | "memory"
  | "agent"
  | "automation";

export interface RunContinuationToolCall {
  id: string;
  name: string;
  input: unknown;
  inputHash: string;
  kind: RunContinuationToolKind;
}

/**
 * V1 fields remain optional-compatible so historical checkpoints stay
 * inspectable. Only V2 checkpoints participate in execution-aware recovery.
 */
export interface RunContinuationState {
  version: 1 | 2;
  runId: string;
  threadId: string;
  status: RunContinuationStatus;
  checkpoint: {
    step:
      | "before_model_call"
      | "before_tool_execution"
      | "waiting_for_tool_result"
      | "after_tool_result";
    interruptionId?: string;
    toolCallId?: string;
    toolName?: string;
    toolKind?: RunContinuationToolKind;
    toolCall?: RunContinuationToolCall;
    processJobId?: string;
    syntheticToolResult?: unknown;
  };
  /**
   * #650：主槽 checkpoint 只承载最新一个后台任务；其余并存任务的续跑快照
   * 按 processJobId 追加于此，终态回填与恢复聚合时一并消费，避免单槽互相覆盖。
   */
  backgroundCheckpoints?: Array<{
    processJobId: string;
    toolCallId: string;
    toolName: string;
    toolKind: RunContinuationToolKind;
    toolCall: RunContinuationToolCall;
    syntheticToolResult?: unknown;
    updatedAt: string;
  }>;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}
