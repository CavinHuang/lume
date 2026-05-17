import type { AgentRuntimeRunResult } from "./types";
import type { LumeRunStatus } from "./run-state";

export interface LumeRunResult {
  status: Extract<LumeRunStatus, "completed" | "failed" | "cancelled">;
  finalOutput?: string;
  error?: string;
}

export function fromAgentRuntimeRunResult(result: AgentRuntimeRunResult): LumeRunResult {
  if (result.status === "completed" || result.status === "turn_limited") {
    return { status: "completed" };
  }
  if (result.status === "aborted") {
    return { status: "cancelled", error: "runtime aborted" };
  }
  return {
    status: "failed",
    error: result.errorMessage ?? "runtime errored"
  };
}
