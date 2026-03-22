import type { AgentMessage, SubagentRunStatus } from "@lume/shared";

export interface SubagentAnnounceBusEvent {
  sessionId: string;
  runId: string;
  childSessionId: string;
  status: SubagentRunStatus;
  message: AgentMessage;
}

type Listener = (event: SubagentAnnounceBusEvent) => void;

const listeners = new Set<Listener>();

export function emitSubagentAnnounceEvent(event: SubagentAnnounceBusEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // no-op, bus listener failures must not break runtime path
    }
  }
}

export function subscribeSubagentAnnounceEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
