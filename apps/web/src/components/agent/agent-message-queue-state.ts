import type { AgentMessageQueueSnapshot } from '@lume/shared'

export function createEmptyAgentMessageQueueSnapshot(threadId: string): AgentMessageQueueSnapshot {
  return {
    threadId,
    queuedMessages: [],
    pendingGuidance: [],
  }
}

export function upsertAgentMessageQueueSnapshot(
  state: Record<string, AgentMessageQueueSnapshot>,
  snapshot: AgentMessageQueueSnapshot,
): Record<string, AgentMessageQueueSnapshot> {
  return {
    ...state,
    [snapshot.threadId]: snapshot,
  }
}

export function reorderQueuedMessages(
  snapshot: AgentMessageQueueSnapshot,
  draggedId: string,
  targetId: string,
): AgentMessageQueueSnapshot {
  if (draggedId === targetId) return snapshot
  const fromIndex = snapshot.queuedMessages.findIndex((item) => item.id === draggedId)
  const toIndex = snapshot.queuedMessages.findIndex((item) => item.id === targetId)
  if (fromIndex < 0 || toIndex < 0) return snapshot

  const queuedMessages = [...snapshot.queuedMessages]
  const [dragged] = queuedMessages.splice(fromIndex, 1)
  if (!dragged) return snapshot
  queuedMessages.splice(toIndex, 0, dragged)

  return {
    ...snapshot,
    queuedMessages,
  }
}
