import type { AgentRuntimePhase, AgentRuntimeStatus } from "@lume/shared";

type AgentRuntimeStatusListener = (status: AgentRuntimeStatus) => void;

interface RuntimeStatusPatch {
  phase: AgentRuntimePhase;
  queuedCount?: number;
  interactiveKind?: "tool_permission" | "ask_user_question";
  requestId?: string;
  toolUseId?: string;
  toolName?: string;
  originThreadId?: string;
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
    threadId: string,
    input: {
      requestId: string;
      toolUseId?: string;
      toolName?: string;
      originThreadId?: string;
      subagentRunId?: string;
    }
  ): AgentRuntimeStatus {
    return this.update(threadId, {
      phase: "awaiting_permission",
      interactiveKind: "tool_permission",
      requestId: input.requestId,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      originThreadId: input.originThreadId,
      subagentRunId: input.subagentRunId
    });
  }

  markAwaitingUserAnswer(
    threadId: string,
    input: { toolUseId: string; originThreadId?: string; subagentRunId?: string }
  ): AgentRuntimeStatus {
    return this.update(threadId, {
      phase: "awaiting_user_answer",
      interactiveKind: "ask_user_question",
      toolUseId: input.toolUseId,
      originThreadId: input.originThreadId,
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

  setQueuedCount(threadId: string, queuedCount: number): AgentRuntimeStatus {
    const current = this.statuses.get(threadId);
    return this.update(threadId, {
      phase: current?.phase ?? "idle",
      queuedCount: Math.max(0, queuedCount),
      interactiveKind: current?.interactiveKind,
      requestId: current?.requestId,
      toolUseId: current?.toolUseId,
      toolName: current?.toolName,
      originThreadId: current?.originThreadId,
      subagentRunId: current?.subagentRunId,
      error: current?.error
    });
  }

  clearSession(sessionId: string): void {
    this.statuses.delete(sessionId);
  }

  private update(threadId: string, patch: RuntimeStatusPatch): AgentRuntimeStatus {
    const previous = this.statuses.get(threadId);
    const next: AgentRuntimeStatus = {
      threadId,
      phase: patch.phase,
      queuedCount: patch.queuedCount ?? previous?.queuedCount ?? 0,
      ...(patch.interactiveKind ? { interactiveKind: patch.interactiveKind } : {}),
      ...(patch.requestId ? { requestId: patch.requestId } : {}),
      ...(patch.toolUseId ? { toolUseId: patch.toolUseId } : {}),
      ...(patch.toolName ? { toolName: patch.toolName } : {}),
      ...(patch.originThreadId ? { originThreadId: patch.originThreadId } : {}),
      ...(patch.subagentRunId ? { subagentRunId: patch.subagentRunId } : {}),
      ...(patch.error ? { error: patch.error } : {}),
      updatedAt: Date.now()
    };
    this.statuses.set(threadId, next);
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
