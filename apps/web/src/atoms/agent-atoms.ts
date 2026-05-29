import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentThreadMeta, AgentRuntimeStatus, AgentPendingInteractiveState, SubagentRunRecord, PlanModePhaseChangedEvent, AgentSendInput } from '@lume/shared'
import type { RuntimeEventState } from '@/hooks/runtime-event-state'

export const agentThreadsAtom = atom<AgentThreadMeta[]>([])
export const currentThreadIdAtom = atom<string | null>(null)

export type StreamingState = 'idle' | 'streaming' | 'errored'
export const agentStreamingStatesAtom = atom<Record<string, StreamingState>>({})
export const agentRuntimeStatusAtom = atom<Record<string, AgentRuntimeStatus>>({})
export const agentRuntimeEventsAtom = atom<RuntimeEventState>({})
export const agentPendingInteractiveAtom = atom<Record<string, AgentPendingInteractiveState>>({})
export const agentSubagentRunsAtom = atom<Record<string, SubagentRunRecord[]>>({})

export const agentPlanModePhaseAtom = atom<Record<string, PlanModePhaseChangedEvent>>({})
export const agentErrorMessagesAtom = atom<Record<string, string>>({})

export type AgentThreadPermissionMode = NonNullable<AgentSendInput['permissionMode']>
export const agentThreadPermissionModesAtom = atom<Record<string, AgentThreadPermissionMode>>({})

export type SidePanelView = 'files' | 'task-progress' | 'trace' | null
export const agentSidePanelViewAtom = atomWithStorage<Record<string, SidePanelView>>(
  'agent-side-panel-view', {}
)
export const agentFileTreeOpenAtom = atomWithStorage<Record<string, boolean>>(
  'agent-file-tree-open', {}
)
