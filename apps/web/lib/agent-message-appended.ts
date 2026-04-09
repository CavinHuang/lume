import type { AgentMessage } from "@lume/shared";

export function appendPersistedAgentMessage(
  existing: AgentMessage[],
  next: AgentMessage
): AgentMessage[] {
  const duplicateIndex = existing.findIndex((message) => message.id === next.id);
  if (duplicateIndex >= 0) {
    const updated = [...existing];
    updated[duplicateIndex] = next;
    return updated;
  }

  const merged = [...existing, next];
  merged.sort((a, b) => a.createdAt - b.createdAt);
  return merged;
}
