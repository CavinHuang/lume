import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AgentSendInput, SDKMessage } from '@lume/shared'

export const agentSend = (input: AgentSendInput) =>
  invoke<{ ok: true }>('sidecar_call', {
    method: 'agent:send-thread-message',
    params: input,
  })

export const onSidecarEvent = (
  cb: (method: string, params: unknown) => void
) => listen<{ method: string; params: unknown }>('sidecar:event', (e) =>
  cb(e.payload.method, e.payload.params)
)

export const listThreads = () =>
  invoke('sidecar_call', { method: 'agent:list-threads', params: null })

export const createThread = (workspaceId?: string) =>
  invoke('sidecar_call', { method: 'agent:create-thread', params: { workspaceId } })

/** 获取线程的原始 SDK 消息（用于恢复历史） */
export const getThreadSDKMessages = (threadId: string) =>
  invoke<{ messages: SDKMessage[] }>('sidecar_call', {
    method: 'agent:get-thread-sdk-messages',
    params: { threadId },
  })
