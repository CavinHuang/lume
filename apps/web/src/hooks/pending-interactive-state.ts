import type {
  AgentAskUserQuestionRequest,
  AgentPendingInteractiveState,
  AgentTaskApprovalRequest,
  AgentToolPermissionRequest,
  LumeRuntimeEvent,
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

export function upsertPendingTaskApproval(
  prev: Record<string, AgentPendingInteractiveState>,
  request: AgentTaskApprovalRequest,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[request.threadId] ?? { threadId: request.threadId }
  return {
    ...prev,
    [request.threadId]: {
      ...current,
      threadId: request.threadId,
      taskApprovals: upsertByKey(current.taskApprovals, request, (item) => item.contractId),
    },
  }
}

export function planPreviewToPendingTaskApproval(
  event: Extract<LumeRuntimeEvent, { type: "plan.preview" }>,
): AgentTaskApprovalRequest {
  return {
    threadId: event.threadId,
    runId: event.runId,
    requestId: `task_approval:${event.contractId}`,
    contractId: event.contractId,
    title: event.title,
    message: "审阅任务计划",
    summary: event.summary,
    stepCount: event.stepCount,
    ...(event.planFilePath ? { planFilePath: event.planFilePath } : {}),
    ...(event.planVerified !== undefined ? { planVerified: event.planVerified } : {}),
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
    next[threadId] = { ...state, toolPermissions }
  }
  return changed ? next : prev
}

export function removePendingTaskApproval(
  prev: Record<string, AgentPendingInteractiveState>,
  threadId: string,
  contractId: string,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[threadId]
  if (!current) return prev
  return {
    ...prev,
    [threadId]: {
      ...current,
      taskApprovals: (current.taskApprovals ?? []).filter((item) => item.contractId !== contractId),
    },
  }
}

export function removePendingTaskApprovalsForThread(
  prev: Record<string, AgentPendingInteractiveState>,
  threadId: string,
): Record<string, AgentPendingInteractiveState> {
  const current = prev[threadId]
  if (!current || (current.taskApprovals ?? []).length === 0) return prev
  return {
    ...prev,
    [threadId]: {
      ...current,
      taskApprovals: [],
    },
  }
}
