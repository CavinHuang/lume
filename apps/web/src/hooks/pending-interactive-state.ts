import type {
  AgentAskUserQuestionRequest,
  AgentPendingInteractiveState,
  AgentToolPermissionRequest,
} from "@lume/shared"

function upsertByKey<T>(
  items: T[] | undefined,
  nextItem: T,
  getKey: (item: T) => string,
): T[] {
  const existing = items ?? []
  const key = getKey(nextItem)
  const index = existing.findIndex((item) => getKey(item) === key)
  if (index >= 0) {
    const updated = [...existing]
    updated[index] = nextItem
    return updated
  }
  return [...existing, nextItem]
}

export function upsertPendingAskUserQuestion(
  prev: Record<string, AgentPendingInteractiveState>,
  request: AgentAskUserQuestionRequest,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[request.threadId] ?? { threadId: request.threadId }
  return {
    ...prev,
    [request.threadId]: {
      ...current,
      threadId: request.threadId,
      askUserQuestions: upsertByKey(current.askUserQuestions, request, (item) => item.toolUseId),
    },
  }
}

export function upsertPendingToolPermission(
  prev: Record<string, AgentPendingInteractiveState>,
  request: AgentToolPermissionRequest,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[request.threadId] ?? { threadId: request.threadId }
  return {
    ...prev,
    [request.threadId]: {
      ...current,
      threadId: request.threadId,
      toolPermissions: upsertByKey(current.toolPermissions, request, (item) => item.requestId),
    },
  }
}

export function removePendingAskUserQuestion(
  prev: Record<string, AgentPendingInteractiveState>,
  threadId: string,
  toolUseId: string,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[threadId]
  if (!current) return prev
  return {
    ...prev,
    [threadId]: {
      ...current,
      askUserQuestions: (current.askUserQuestions ?? []).filter((item) => item.toolUseId !== toolUseId),
    },
  }
}

export function removePendingToolPermission(
  prev: Record<string, AgentPendingInteractiveState>,
  threadId: string,
  requestId: string,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[threadId]
  if (!current) return prev
  return {
    ...prev,
    [threadId]: {
      ...current,
      toolPermissions: (current.toolPermissions ?? []).filter((item) => item.requestId !== requestId),
    },
  }
}
