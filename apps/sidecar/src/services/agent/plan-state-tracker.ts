import type { AgentSendInput, PlanPhase, PlanStateChangedEvent, PlanStep } from "@lume/shared";

interface PlanExecutionSnapshot {
  steps: PlanStep[];
  currentIndex: number | null;
}

interface PlanPhaseUpdateExtras {
  planPath?: string;
  steps?: PlanStep[];
}

export class PlanStateTracker {
  private readonly phaseBySession = new Map<string, PlanPhase>();
  private readonly executionBySession = new Map<string, PlanExecutionSnapshot>();

  getPhase(sessionId: string): PlanPhase | undefined {
    return this.phaseBySession.get(sessionId);
  }

  clearSession(sessionId: string): void {
    this.phaseBySession.delete(sessionId);
    this.executionBySession.delete(sessionId);
  }

  isLikelyExecutionRequest(input: AgentSendInput): boolean {
    if (input.permissionMode === "plan") return false;
    if (typeof input.messageMetadata?.planExecutionKey === "string") return true;
    const content = (input.userMessage ?? "").trim();
    if (!content) return false;
    return content.includes("请开始执行计划第")
      || content.includes("请切换到执行模式，并从计划文件开始执行第一步");
  }

  parsePlanPathFromToolResult(payload: unknown): string | undefined {
    if (!payload) return undefined;
    if (typeof payload === "string") {
      const text = payload.trim();
      if (!text) return undefined;
      try {
        return this.parsePlanPathFromToolResult(JSON.parse(text));
      } catch {
        return undefined;
      }
    }
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const parsed = this.parsePlanPathFromToolResult(item);
        if (parsed) return parsed;
      }
      return undefined;
    }
    if (typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    const directPath = record.planPath;
    if (typeof directPath === "string" && directPath.trim().length > 0) {
      return directPath.trim();
    }
    if (Array.isArray(record.content)) {
      for (const chunk of record.content) {
        if (!chunk || typeof chunk !== "object") continue;
        const text = (chunk as Record<string, unknown>).text;
        if (typeof text !== "string" || text.trim().length === 0) continue;
        const parsed = this.parsePlanPathFromToolResult(text);
        if (parsed) return parsed;
      }
    }
    return undefined;
  }

  syncExecutionFromUserMessage(sessionId: string, userMessage: string): PlanStep[] | undefined {
    const parsed = this.parseExecutionStepRequest(userMessage);
    if (!parsed) return undefined;
    const current = this.executionBySession.get(sessionId) ?? { steps: [], currentIndex: null };
    const nextSteps = [...current.steps];
    while (nextSteps.length <= parsed.index) {
      const stepNo = nextSteps.length + 1;
      nextSteps.push({
        id: `step-${stepNo}`,
        text: `执行计划第 ${stepNo} 步`,
        status: "pending",
        failCount: 0,
        lastError: null
      });
    }
    nextSteps.forEach((step, idx) => {
      if (idx === parsed.index) {
        step.status = "in_progress";
        step.lastError = null;
        if (parsed.text) step.text = parsed.text;
        return;
      }
      if (idx < parsed.index && step.status !== "completed") {
        step.status = "completed";
        step.lastError = null;
        return;
      }
      if (idx > parsed.index && step.status === "in_progress") {
        step.status = "pending";
      }
    });
    this.executionBySession.set(sessionId, {
      steps: nextSteps,
      currentIndex: parsed.index
    });
    return nextSteps;
  }

  markCurrentStepCompleted(sessionId: string): PlanStep[] | undefined {
    const current = this.executionBySession.get(sessionId);
    if (!current || current.currentIndex === null) return current?.steps;
    const nextSteps = current.steps.map((step, idx) => (
      idx === current.currentIndex
        ? { ...step, status: "completed" as const, lastError: null }
        : step
    ));
    this.executionBySession.set(sessionId, { steps: nextSteps, currentIndex: null });
    return nextSteps;
  }

  markCurrentStepFailed(sessionId: string, error: string): PlanStep[] | undefined {
    const current = this.executionBySession.get(sessionId);
    if (!current || current.currentIndex === null) return current?.steps;
    const nextSteps = current.steps.map((step, idx) => (
      idx === current.currentIndex
        ? {
          ...step,
          status: "failed" as const,
          failCount: step.failCount + 1,
          lastError: error
        }
        : step
    ));
    this.executionBySession.set(sessionId, { steps: nextSteps, currentIndex: null });
    return nextSteps;
  }

  updatePhase(
    sessionId: string,
    phase: PlanPhase,
    extras?: PlanPhaseUpdateExtras
  ): PlanStateChangedEvent | null {
    const prev = this.phaseBySession.get(sessionId);
    const phaseChanged = prev !== phase;
    const nextPath = extras?.planPath?.trim();
    if (phaseChanged) {
      this.phaseBySession.set(sessionId, phase);
    }
    if (!phaseChanged && !nextPath && !extras?.steps) {
      return null;
    }
    return {
      threadId: sessionId,
      phase,
      ...(nextPath ? { planPath: nextPath } : {}),
      ...(extras?.steps ? { steps: extras.steps } : {})
    };
  }

  private parseExecutionStepRequest(userMessage: string): { index: number; text: string } | null {
    const directMatch = userMessage.match(/请开始执行计划第\s*(\d+)\s*步[:：]\s*([\s\S]*?)(?:\n|$)/);
    if (directMatch) {
      const rawIndex = Number.parseInt(directMatch[1] ?? "", 10);
      const text = (directMatch[2] ?? "").trim();
      if (!Number.isNaN(rawIndex) && rawIndex > 0) {
        return { index: rawIndex - 1, text };
      }
    }
    const fromPlanMatch = userMessage.match(/从计划文件开始执行第一步/);
    if (fromPlanMatch) {
      return { index: 0, text: "根据计划文件执行第 1 步" };
    }
    return null;
  }
}

