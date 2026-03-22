import type { AgentEvent } from "@lume/shared";

type SessionEventListener = (event: AgentEvent) => void;

class SessionEventBus {
  private listeners = new Map<string, Set<SessionEventListener>>();

  subscribe(sessionId: string, listener: SessionEventListener): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set());
    }
    this.listeners.get(sessionId)!.add(listener);
    return () => {
      const set = this.listeners.get(sessionId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(sessionId);
        }
      }
    };
  }

  emit(sessionId: string, event: AgentEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[SessionEventBus] listener error for session ${sessionId}:`, error);
      }
    }
  }

  removeAll(sessionId: string): void {
    this.listeners.delete(sessionId);
  }
}

const instance = new SessionEventBus();

export function getSessionEventBus(): SessionEventBus {
  return instance;
}
