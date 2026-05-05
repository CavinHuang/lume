import type { AgentSendInput, PlanPhase, PlanStateChangedEvent } from "@lume/shared";

export class PlanStateTracker {
  private readonly phaseBySession = new Map<string, PlanPhase>();

  getPhase(sessionId: string): PlanPhase | undefined {
    return this.phaseBySession.get(sessionId);
  }

  clearSession(sessionId: string): void {
    this.phaseBySession.delete(sessionId);
  }

  isLikelyExecutionRequest(input: AgentSendInput): boolean {
    if (input.permissionMode === "plan") return false;
    return typeof input.messageMetadata?.taskRunId === "string"
      && typeof input.messageMetadata?.taskId === "string";
  }

  updatePhase(
    sessionId: string,
    phase: PlanPhase
  ): PlanStateChangedEvent | null {
    const prev = this.phaseBySession.get(sessionId);
    const phaseChanged = prev !== phase;
    if (phaseChanged) {
      this.phaseBySession.set(sessionId, phase);
    }
    if (!phaseChanged) {
      return null;
    }
    return {
      threadId: sessionId,
      phase
    };
  }
}
