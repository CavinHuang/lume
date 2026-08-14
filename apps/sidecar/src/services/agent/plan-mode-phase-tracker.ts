import type { PlanModePhase, PlanModePhaseChangedEvent } from "@lume/shared";

export class PlanModePhaseTracker {
  private readonly phaseBySession = new Map<string, PlanModePhase>();

  getPhase(sessionId: string): PlanModePhase | undefined {
    return this.phaseBySession.get(sessionId);
  }

  clearSession(sessionId: string): void {
    this.phaseBySession.delete(sessionId);
  }

  updatePhase(
    sessionId: string,
    phase: PlanModePhase
  ): PlanModePhaseChangedEvent | null {
    const prev = this.phaseBySession.get(sessionId);
    const phaseChanged = prev !== phase;
    if (phaseChanged) {
      this.phaseBySession.set(sessionId, phase);
    }
    if (!phaseChanged && phase !== "awaiting_approval") {
      return null;
    }
    return {
      threadId: sessionId,
      phase
    };
  }
}
