import type { AgentRuntimePhase, AgentRuntimeStatus } from "@lume/shared";

export function isAgentRuntimePhaseActive(phase: AgentRuntimePhase | undefined): boolean {
  return phase === "streaming"
    || phase === "awaiting_permission"
    || phase === "awaiting_user_answer"
    || phase === "compacting";
}

export function isAgentRuntimeAwaitingInput(status: AgentRuntimeStatus | null | undefined): boolean {
  return status?.phase === "awaiting_permission" || status?.phase === "awaiting_user_answer";
}

export function isAgentRuntimeStatusActive(status: AgentRuntimeStatus | null | undefined): boolean {
  return isAgentRuntimePhaseActive(status?.phase);
}

export function resolveAgentBusyState(
  status: AgentRuntimeStatus | null | undefined,
  localStreaming: boolean
): boolean {
  if (status) {
    return isAgentRuntimeStatusActive(status);
  }
  return localStreaming;
}
