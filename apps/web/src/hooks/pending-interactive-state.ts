import type {
  AgentAskUserQuestionRequest,
  AgentBrowserAuthRequest,
  AgentDesktopActionRequest,
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

export function upsertPendingBrowserAuthRequest(
  prev: Record<string, AgentPendingInteractiveState>,
  request: AgentBrowserAuthRequest,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[request.threadId] ?? { threadId: request.threadId }
  return {
    ...prev,
    [request.threadId]: {
      ...current,
      threadId: request.threadId,
      browserAuthRequests: upsertByKey(current.browserAuthRequests, request, (item) => item.requestId),
    },
  }
}

export function upsertPendingDesktopActionRequest(
  prev: Record<string, AgentPendingInteractiveState>,
  request: AgentDesktopActionRequest,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[request.threadId] ?? { threadId: request.threadId }
  return {
    ...prev,
    [request.threadId]: {
      ...current,
      desktopActionRequests: upsertByKey(current.desktopActionRequests, request, (item) => item.requestId),
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

export function removePendingBrowserAuthRequest(
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
      browserAuthRequests: (current.browserAuthRequests ?? []).filter((item) => item.requestId !== requestId),
    },
  }
}

export function removePendingDesktopActionRequest(
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
      desktopActionRequests: (current.desktopActionRequests ?? []).filter((item) => item.requestId !== requestId),
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

export function removePendingToolPermissionEverywhere(
  prev: Record<string, AgentPendingInteractiveState>,
  requestId: string,
): Record<string, AgentPendingInteractiveState> {
  let changed = false
  const next: Record<string, AgentPendingInteractiveState> = {}
  for (const [threadId, state] of Object.entries(prev)) {
    const currentPermissions = state.toolPermissions ?? []
    const toolPermissions = currentPermissions.filter((item) => item.requestId !== requestId)
    changed ||= toolPermissions.length !== currentPermissions.length
    next[threadId] = toolPermissions.length === currentPermissions.length
      ? state
      : { ...state, toolPermissions }
  }
  return changed ? next : prev
}
