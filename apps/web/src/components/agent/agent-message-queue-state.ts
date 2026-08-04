import type { AgentMessageQueueSnapshot } from '@lume/shared'

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

/**
 * 按 orderedIds 重排 queuedMessages 中的 visible(非 internal)项;
 * internal 项保留原相对位置。orderedIds 中不存在于快照的 id 被忽略。
 * 供 @dnd-kit onDragEnd 产出新顺序后做乐观更新。
 */
export function applyOrderByIds(
  snapshot: AgentMessageQueueSnapshot,
  orderedIds: string[],
): AgentMessageQueueSnapshot {
  const orderedSet = new Set(orderedIds)
  const byId = new Map(snapshot.queuedMessages.map((m) => [m.id, m]))
  let visIdx = 0
  const queuedMessages = snapshot.queuedMessages.map((m) => {
    if (!orderedSet.has(m.id)) return m // internal 或未参与拖拽：原位
    const next = byId.get(orderedIds[visIdx])
    visIdx += 1
    return next ?? m
  })
  if (queuedMessages.every((m, i) => m.id === snapshot.queuedMessages[i]?.id)) return snapshot
  return { ...snapshot, queuedMessages }
}

export function startEditingQueuedMessage(
  snapshot: AgentMessageQueueSnapshot,
  queuedMessageId: string,
): { draftText: string; queuedMessage: AgentMessageQueueSnapshot['queuedMessages'][number]; snapshot: AgentMessageQueueSnapshot } | null {
  const queuedMessage = snapshot.queuedMessages.find((item) => item.id === queuedMessageId)
  if (!queuedMessage) return null
  return {
    draftText: queuedMessage.text,
    queuedMessage,
    snapshot,
  }
}
