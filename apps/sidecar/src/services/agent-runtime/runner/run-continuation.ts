export type RunContinuationStatus =
  | "ready_to_resume"
  | "waiting_for_interruption"
  | "tool_running"
  | "resumed"
  | "not_resumable";

export interface RunContinuationState {
  version: 1;
  runId: string;
  threadId: string;
  status: RunContinuationStatus;
  checkpoint: {
    step: "before_model_call" | "waiting_for_tool_result" | "after_tool_result";
    interruptionId?: string;
    toolCallId?: string;
    toolName?: string;
    toolKind?: "read" | "write" | "execute" | "control" | "network" | "memory" | "agent" | "automation";
    syntheticToolResult?: unknown;
  };
  reason?: string;
  createdAt: string;
  updatedAt: string;
}
