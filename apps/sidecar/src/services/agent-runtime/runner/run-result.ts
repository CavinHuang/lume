import type { AgentRuntimeRunResult } from "../runtime-core/types";
import type { LumeRunStatus } from "../runtime-core/run-state";

export interface LumeRunResult {
  status: Extract<LumeRunStatus, "completed" | "failed" | "cancelled">;
  finalOutput?: string;
  error?: string;
  verificationStatus?: "not_required" | "unverified" | "verified" | "failed";
  codingReport?: AgentRuntimeRunResult["codingReport"];
}

export function fromAgentRuntimeRunResult(result: AgentRuntimeRunResult): LumeRunResult {
  if (result.status === "completed" || result.status === "turn_limited") {
    return { status: "completed", verificationStatus: result.verificationStatus, codingReport: result.codingReport };
  }
  if (result.status === "aborted") {
    return { status: "cancelled", error: "runtime aborted", verificationStatus: result.verificationStatus, codingReport: result.codingReport };
  }
  return {
    status: "failed",
    error: result.errorMessage ?? "runtime errored",
    verificationStatus: result.verificationStatus,
    codingReport: result.codingReport
  };
}
