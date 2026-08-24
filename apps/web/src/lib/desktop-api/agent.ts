import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import { writeWebLogEvent } from './logger'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import type {
  AgentResumeRunInput,
  AgentResumeRunResult,
  AgentDiscardInterruptedRunInput,
  AgentDiscardInterruptedRunResult,
  AgentGetPendingResumeResult,
  AgentListRunStatesInput,
  AgentListRunStatesResult,
  AgentPendingInteractiveInput,
  AgentPendingInteractiveState,
  AgentRunTraceInput,
  AgentRunTraceResult,
  AgentSendInput,
  AgentGetMessageVersionsInput,
  AgentMessageVersionsResult,
  AgentMessage,
  AgentMessageAppendedEvent,
  AgentRecentThreadMessagesResult,
  AgentThreadRuntimeEventsResult,
  AgentMessageQueueInput,
  AgentMessageQueueOperationResult,
  AgentMessageQueueSnapshot,
  AgentPromoteQueuedMessageToGuidanceInput,
  AgentRemoveQueuedMessageInput,
  AgentReorderMessageQueueInput,
  AgentRetryQueuedMessageInput,
  AgentResumeQueueInput,
  AgentThreadMessageDispatchResult,
  AgentUpdateQueuedMessageInput,
  AgentGetSubmissionReceiptInput,
  AgentGetSubmissionReceiptResult,
  AgentEventsResult,
  SdkEventEnvelope,
} from '@lume/shared'

export const agentSend = async (input: AgentSendInput) => {
  const submissionId = input.traceContext?.submissionId ?? crypto.randomUUID()
  const clientEventId = input.traceContext?.clientEventId ?? crypto.randomUUID()
  const traceContext = { ...input.traceContext, submissionId, clientEventId }
  writeWebLogEvent({
    level: 'info',
    kind: 'trace',
    context: 'agent.dispatch',
    event: 'message.submitted',
    message: 'agent message submitted by renderer',
    submissionId,
    threadId: input.threadId,
    data: { messageLength: input.userMessage.length },
  })
  let result: AgentThreadMessageDispatchResult
  try {
    result = await invoke<AgentThreadMessageDispatchResult>('sidecar_call', {
      method: AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE,
      params: { ...input, traceContext },
    })
  } catch (error) {
    if (!input.clientSubmissionId) throw error
    const lookup = await getAgentSubmissionReceipt({ clientSubmissionId: input.clientSubmissionId })
      .catch(() => undefined)
    const receipt = lookup?.receipt
    if (receipt && ['rejected', 'failed', 'interrupted', 'restart_dropped'].includes(receipt.status)) {
      const terminalError = new Error(`提交已终结：${receipt.status}`) as Error & { submissionTerminal?: boolean }
      terminalError.submissionTerminal = true
      throw terminalError
    }
    if (!receipt || !['accepted', 'queued', 'started', 'completed'].includes(receipt.status)) throw error
    result = {
      ok: true,
      mode: receipt.mode ?? (receipt.status === 'queued' ? 'queued' : 'sent'),
      queuedCount: receipt.status === 'queued' ? 1 : 0,
      ...(receipt.queuedMessageId
        ? {
            queuedMessage: {
              id: receipt.queuedMessageId,
              threadId: receipt.threadId,
              text: input.userMessage,
              createdAt: receipt.createdAt,
              revision: 0,
              status: 'queued' as const,
              ...(input.messageParts ? { messageParts: input.messageParts } : {}),
              ...(input.messageAttachments ? { messageAttachments: input.messageAttachments } : {}),
              ...(input.commentAttachments ? { commentAttachments: input.commentAttachments } : {}),
              ...(input.browserAttachments ? { browserAttachments: input.browserAttachments } : {}),
            },
          }
        : {}),
    }
  }
  writeWebLogEvent({
    level: 'info',
    kind: 'trace',
    context: 'agent.dispatch',
    event: result.mode === 'queued' ? 'agent.queue.accepted' : 'agent.execution.accepted',
    message: result.mode === 'queued' ? 'agent message queued' : 'agent execution accepted',
    status: 'ok',
    traceId: result.traceId,
    submissionId,
    threadId: input.threadId,
    data: { mode: result.mode, queuedCount: result.queuedCount },
  })
  return result
}

export function isTerminalAgentSubmissionError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { submissionTerminal?: unknown }).submissionTerminal === true)
}

export const onSidecarEvent = (
  cb: (method: string, params: unknown) => void
) => listen<{ method: string; params: unknown }>('sidecar:event', (e) => {
  const { method, params } = e.payload
  const appended = method === AGENT_IPC_CHANNELS.MESSAGE_APPENDED
    && params && typeof params === 'object'
    && (params as AgentMessageAppendedEvent).message?.role === 'assistant'
    && typeof (params as AgentMessageAppendedEvent).deliveryAttemptId === 'string'
    ? params as AgentMessageAppendedEvent
    : null
  if (appended) {
    writeWebLogEvent({
      level: 'info',
      kind: 'trace',
      context: 'agent.delivery',
      event: 'reply.received',
      message: 'assistant reply received by renderer',
      status: 'ok',
      traceId: appended.traceId,
      submissionId: appended.submissionId,
      deliveryAttemptId: appended.deliveryAttemptId,
      threadId: appended.threadId,
      messageId: appended.message.id,
    })
  }
  cb(method, params)
})

export const acknowledgeRendererDelivery = (event: AgentMessageAppendedEvent) => {
  if (!event.deliveryAttemptId) return Promise.resolve({ ok: false })
  return invoke<{ ok: boolean }>('ack_renderer_delivery', {
    deliveryAttemptId: event.deliveryAttemptId,
    threadId: event.threadId,
    messageId: event.message.id,
  })
}

export const listThreads = () =>
  invoke('sidecar_call', { method: AGENT_IPC_CHANNELS.LIST_THREADS, params: null })

export const createThread = (workspaceId?: string) =>
  invoke('sidecar_call', { method: AGENT_IPC_CHANNELS.CREATE_THREAD, params: { workspaceId } })

export const getThreadRuntimeEvents = (threadId: string) =>
  invoke<AgentThreadRuntimeEventsResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_THREAD_RUNTIME_EVENTS,
    params: { threadId },
  })

export const getThreadMessages = (threadId: string) =>
  invoke<AgentMessage[]>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES,
    params: { threadId },
  })

export const getRecentThreadMessages = (threadId: string, limit: number) =>
  invoke<AgentRecentThreadMessagesResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_RECENT_THREAD_MESSAGES,
    params: { threadId, limit },
  })

export const getThreadMessageVersions = (input: AgentGetMessageVersionsInput) =>
  invoke<AgentMessageVersionsResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_THREAD_MESSAGE_VERSIONS,
    params: input,
  })

export const getPendingInteractive = (input: AgentPendingInteractiveInput = {}) =>
  invoke<AgentPendingInteractiveState[]>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE,
    params: input,
  })

export const resumeAgentRun = (input: AgentResumeRunInput) =>
  invoke<AgentResumeRunResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.RESUME_RUN,
    params: input,
  })

export const discardAgentInterruptedRun = (input: AgentDiscardInterruptedRunInput) =>
  invoke<AgentDiscardInterruptedRunResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.DISCARD_INTERRUPTED_RUN,
    params: input,
  })

export const getAgentPendingResume = (threadId: string) =>
  invoke<AgentGetPendingResumeResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_PENDING_RESUME,
    params: { threadId },
  })

export const listAgentRunStates = (input: AgentListRunStatesInput) =>
  invoke<AgentListRunStatesResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.LIST_RUN_STATES,
    params: input,
  })

export const getAgentRunTrace = (input: AgentRunTraceInput) =>
  invoke<AgentRunTraceResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_RUN_TRACE,
    params: input,
  })

export const listAgentMessageQueue = (input: AgentMessageQueueInput) =>
  invoke<AgentMessageQueueSnapshot>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.LIST_MESSAGE_QUEUE,
    params: input,
  })

export const reorderAgentMessageQueue = (input: AgentReorderMessageQueueInput) =>
  invoke<AgentMessageQueueOperationResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.REORDER_MESSAGE_QUEUE,
    params: input,
  })

export const removeQueuedAgentMessage = (input: AgentRemoveQueuedMessageInput) =>
  invoke<AgentMessageQueueOperationResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.REMOVE_QUEUED_MESSAGE,
    params: input,
  })

export const retryQueuedAgentMessage = (input: AgentRetryQueuedMessageInput) =>
  invoke<AgentMessageQueueOperationResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.RETRY_QUEUED_MESSAGE,
    params: input,
  })

export const resumeAgentQueue = (input: AgentResumeQueueInput) =>
  invoke<AgentMessageQueueOperationResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.RESUME_QUEUE,
    params: input,
  })

export const getAgentSubmissionReceipt = (input: AgentGetSubmissionReceiptInput) =>
  invoke<AgentGetSubmissionReceiptResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_SUBMISSION_RECEIPT,
    params: input,
  })

export const updateQueuedAgentMessage = (input: AgentUpdateQueuedMessageInput) =>
  invoke<AgentMessageQueueOperationResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.UPDATE_QUEUED_MESSAGE,
    params: input,
  })

export const getAgentEvents = (threadId: string, afterSeq?: number) =>
  invoke<AgentEventsResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_EVENTS,
    params: { threadId, ...(afterSeq !== undefined ? { afterSeq } : {}) },
  })

// Sidecar notifications all reach the renderer multiplexed on 'sidecar:event'
// ({ method, params }) — the dedicated 'agent:events' channel is not in the
// preload allowlist, so filter by method like onSidecarEvent does.
export const onAgentEvents = (cb: (e: SdkEventEnvelope) => void) =>
  listen<{ method: string; params: SdkEventEnvelope }>('sidecar:event', (ev) => {
    if (ev.payload.method === AGENT_IPC_CHANNELS.EVENTS) cb(ev.payload.params)
  })

export const promoteQueuedAgentMessageToGuidance = (input: AgentPromoteQueuedMessageToGuidanceInput) =>
  invoke<AgentMessageQueueOperationResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE,
    params: input,
  })
