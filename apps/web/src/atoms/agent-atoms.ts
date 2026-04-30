import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentThreadMeta, AgentRuntimeStatus, AgentPendingInteractiveState, SubagentRunRecord, PlanStateChangedEvent } from '@lume/shared'
import type { RunEventState } from '@/hooks/run-event-state'

export const agentThreadsAtom = atom<AgentThreadMeta[]>([])
export const currentThreadIdAtom = atom<string | null>(null)

export type StreamingState = 'idle' | 'streaming' | 'errored'
export const agentStreamingStatesAtom = atom<Record<string, StreamingState>>({})
export const agentRuntimeStatusAtom = atom<Record<string, AgentRuntimeStatus>>({})
export const agentRunEventsAtom = atom<RunEventState>({})
export const agentPendingInteractiveAtom = atom<Record<string, AgentPendingInteractiveState>>({})
export const agentSubagentRunsAtom = atom<Record<string, SubagentRunRecord[]>>({})

export const agentPlanStateAtom = atom<Record<string, PlanStateChangedEvent>>({})
export const agentErrorMessagesAtom = atom<Record<string, string>>({})

export type SidePanelView = 'files' | 'plan' | 'trace' | null
export const agentSidePanelViewAtom = atomWithStorage<Record<string, SidePanelView>>(
  'agent-side-panel-view', {}
)
