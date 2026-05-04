import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import type {
  AgentResumeRunInput,
  AgentResumeRunResult,
  AgentListRunStatesInput,
  AgentListRunStatesResult,
  AgentPendingInteractiveInput,
  AgentPendingInteractiveState,
  AgentPlanApprovalResponseInput,
  AgentExecutePlanInput,
  AgentExecutePlanResult,
  AgentRunTraceInput,
  AgentRunTraceResult,
  AgentSendInput,
  AgentStructuredPlansInput,
  AgentStructuredPlansResult,
  AgentGetMessageVersionsInput,
  AgentMessageVersionsResult,
  AgentMessage,
  AgentThreadRunEventsResult,
} from '@lume/shared'

export const agentSend = (input: AgentSendInput) =>
  invoke<{ ok: true }>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE,
    params: input,
  })

export const onSidecarEvent = (
  cb: (method: string, params: unknown) => void
) => listen<{ method: string; params: unknown }>('sidecar:event', (e) =>
  cb(e.payload.method, e.payload.params)
)

export const listThreads = () =>
  invoke('sidecar_call', { method: AGENT_IPC_CHANNELS.LIST_THREADS, params: null })

export const createThread = (workspaceId?: string) =>
  invoke('sidecar_call', { method: AGENT_IPC_CHANNELS.CREATE_THREAD, params: { workspaceId } })

export const getThreadRunEvents = (threadId: string) =>
  invoke<AgentThreadRunEventsResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_THREAD_RUN_EVENTS,
    params: { threadId },
  })

export const getThreadMessages = (threadId: string) =>
  invoke<AgentMessage[]>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES,
    params: { threadId },
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

export const listAgentRunStates = (input: AgentListRunStatesInput) =>
  invoke<AgentListRunStatesResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.LIST_RUN_STATES,
    params: input,
  })

export const submitPlanApproval = (input: AgentPlanApprovalResponseInput) =>
  invoke<{ ok: boolean }>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.SUBMIT_PLAN_APPROVAL,
    params: input,
  })

export const executePlan = (input: AgentExecutePlanInput) =>
  invoke<AgentExecutePlanResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.EXECUTE_PLAN,
    params: input,
  })

export const getAgentRunTrace = (input: AgentRunTraceInput) =>
  invoke<AgentRunTraceResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_RUN_TRACE,
    params: input,
  })

export const listStructuredPlans = (input: AgentStructuredPlansInput) =>
  invoke<AgentStructuredPlansResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.LIST_STRUCTURED_PLANS,
    params: input,
  })
