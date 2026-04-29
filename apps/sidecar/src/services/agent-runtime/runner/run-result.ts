import type { PiAgentRunResult } from "../../pi-agent/runner/types";
import type { LumeRunStatus } from "./run-state";

export interface LumeRunResult {
  status: Extract<LumeRunStatus, "completed" | "failed" | "cancelled">;
  finalOutput?: string;
  error?: string;
}

export function fromPiAgentRunResult(result: PiAgentRunResult): LumeRunResult {
  if (result.status === "completed") {
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
