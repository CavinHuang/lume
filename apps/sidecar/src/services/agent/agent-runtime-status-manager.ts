import type { AgentRuntimePhase, AgentRuntimeStatus } from "@lume/shared";

type AgentRuntimeStatusListener = (status: AgentRuntimeStatus) => void;

interface RuntimeStatusPatch {
  phase: AgentRuntimePhase;
  interactiveKind?: "tool_permission" | "ask_user_question";
  requestId?: string;
  toolUseId?: string;
  toolName?: string;
  originSessionId?: string;
  subagentRunId?: string;
  error?: string;
}

export class AgentRuntimeStatusManager {
  private readonly statuses = new Map<string, AgentRuntimeStatus>();
  private readonly listeners = new Set<AgentRuntimeStatusListener>();

  get(sessionId: string): AgentRuntimeStatus | undefined {
    return this.statuses.get(sessionId);
  }

  subscribe(listener: AgentRuntimeStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  markStreaming(sessionId: string): AgentRuntimeStatus {
    return this.update(sessionId, { phase: "streaming" });
  }

  markAwaitingPermission(
    sessionId: string,
    input: {
      requestId: string;
      toolUseId?: string;
      toolName?: string;
      originSessionId?: string;
      subagentRunId?: string;
    }
  ): AgentRuntimeStatus {
    return this.update(sessionId, {
      phase: "awaiting_permission",
      interactiveKind: "tool_permission",
      requestId: input.requestId,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      originSessionId: input.originSessionId,
      subagentRunId: input.subagentRunId
    });
  }

  markAwaitingUserAnswer(
    sessionId: string,
    input: { toolUseId: string; originSessionId?: string; subagentRunId?: string }
  ): AgentRuntimeStatus {
    return this.update(sessionId, {
      phase: "awaiting_user_answer",
      interactiveKind: "ask_user_question",
      toolUseId: input.toolUseId,
      originSessionId: input.originSessionId,
      subagentRunId: input.subagentRunId
    });
  }

  markCompacting(sessionId: string): AgentRuntimeStatus {
    return this.update(sessionId, { phase: "compacting" });
  }

  markCompleted(sessionId: string): AgentRuntimeStatus {
    return this.update(sessionId, { phase: "completed" });
  }

  markErrored(sessionId: string, error: string): AgentRuntimeStatus {
    return this.update(sessionId, { phase: "errored", error });
  }

  markIdle(sessionId: string): AgentRuntimeStatus {
    return this.update(sessionId, { phase: "idle" });
  }

  clearSession(sessionId: string): void {
    this.statuses.delete(sessionId);
  }

  private update(sessionId: string, patch: RuntimeStatusPatch): AgentRuntimeStatus {
    const next: AgentRuntimeStatus = {
      sessionId,
      phase: patch.phase,
      ...(patch.interactiveKind ? { interactiveKind: patch.interactiveKind } : {}),
      ...(patch.requestId ? { requestId: patch.requestId } : {}),
      ...(patch.toolUseId ? { toolUseId: patch.toolUseId } : {}),
      ...(patch.toolName ? { toolName: patch.toolName } : {}),
      ...(patch.originSessionId ? { originSessionId: patch.originSessionId } : {}),
      ...(patch.subagentRunId ? { subagentRunId: patch.subagentRunId } : {}),
      ...(patch.error ? { error: patch.error } : {}),
      updatedAt: Date.now()
    };
    this.statuses.set(sessionId, next);
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }
}

let singleton: AgentRuntimeStatusManager | null = null;

export function getAgentRuntimeStatusManager(): AgentRuntimeStatusManager {
  if (!singleton) {
    singleton = new AgentRuntimeStatusManager();
  }
  return singleton;
}

export function resetAgentRuntimeStatusManagerForTest(): void {
  singleton = null;
}
