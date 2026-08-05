import type { AgentMessageQueueSnapshot } from '@lume/shared'
import { parseQuotedSelectionRefs } from '@/lib/quoted-selection'

export function createEmptyAgentMessageQueueSnapshot(threadId: string): AgentMessageQueueSnapshot {
  return {
    threadId,
    revision: 0,
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
  placement: 'before' | 'after' = 'before',
): AgentMessageQueueSnapshot {
  if (draggedId === targetId) return snapshot
  const fromIndex = snapshot.queuedMessages.findIndex((item) => item.id === draggedId)
  const toIndex = snapshot.queuedMessages.findIndex((item) => item.id === targetId)
  if (fromIndex < 0 || toIndex < 0) return snapshot

  const queuedMessages = [...snapshot.queuedMessages]
  const [dragged] = queuedMessages.splice(fromIndex, 1)
  if (!dragged) return snapshot
  const targetIndexAfterRemoval = queuedMessages.findIndex((item) => item.id === targetId)
  if (targetIndexAfterRemoval < 0) return snapshot
  const insertionIndex = placement === 'after' ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval
  queuedMessages.splice(insertionIndex, 0, dragged)

  return {
    ...snapshot,
    queuedMessages,
  }
}

export function startEditingQueuedMessage(
  snapshot: AgentMessageQueueSnapshot,
  queuedMessageId: string,
): { draftText: string; queuedMessage: AgentMessageQueueSnapshot['queuedMessages'][number]; snapshot: AgentMessageQueueSnapshot } | null {
  const queuedMessage = snapshot.queuedMessages.find((item) => item.id === queuedMessageId)
  if (!queuedMessage) return null
  return {
    // 剥离引用 XML 块：编辑器载入纯净用户文本（引用块在编辑场景视为已消费）
    draftText: parseQuotedSelectionRefs(queuedMessage.text).text,
    queuedMessage,
    snapshot,
  }
}
