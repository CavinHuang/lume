import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentThreadMeta, AgentRuntimeStatus, AgentPendingInteractiveState, SubagentRunRecord, PlanStateChangedEvent } from '@lume/shared'
import type { SDKMessage } from '@lume/shared'

export const agentThreadsAtom = atom<AgentThreadMeta[]>([])
export const currentThreadIdAtom = atom<string | null>(null)
export const agentSDKMessagesAtom = atom<Record<string, SDKMessage[]>>({})

export type StreamingState = 'idle' | 'streaming' | 'errored'
export const agentStreamingStatesAtom = atom<Record<string, StreamingState>>({})
export const agentRuntimeStatusAtom = atom<Record<string, AgentRuntimeStatus>>({})
export const agentPendingInteractiveAtom = atom<Record<string, AgentPendingInteractiveState>>({})
export const agentSubagentRunsAtom = atom<Record<string, SubagentRunRecord[]>>({})
export const agentSubagentMessagesAtom = atom<Record<string, Record<string, SDKMessage[]>>>({})

export interface SubagentToolProgress {
  toolName: string
  toolUseId: string
  elapsedSeconds: number
}
/** 当前每个 subagent run 正在执行的工具 */
export const agentSubagentToolProgressAtom = atom<Record<string, Record<string, SubagentToolProgress>>>({})

export const agentPlanStateAtom = atom<Record<string, PlanStateChangedEvent>>({})
export const agentErrorMessagesAtom = atom<Record<string, string>>({})

export type SidePanelView = 'files' | 'plan' | null
export const agentSidePanelViewAtom = atomWithStorage<Record<string, SidePanelView>>(
  'agent-side-panel-view', {}
)
