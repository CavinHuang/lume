import { atom } from 'jotai'
import { atomFamily, atomWithStorage, selectAtom } from 'jotai/utils'
import type { AgentThreadMeta, AgentRuntimeStatus, AgentPendingInteractiveState, SubagentRunRecord, PlanModePhaseChangedEvent, AgentSendInput, AgentMessageQueueSnapshot } from '@lume/shared'
import type { RuntimeEventState } from '@/hooks/runtime-event-state'

export const agentThreadsAtom = atom<AgentThreadMeta[]>([])
export const currentThreadIdAtom = atom<string | null>(null)

export type StreamingState = 'idle' | 'streaming' | 'errored'
export const agentStreamingStatesAtom = atom<Record<string, StreamingState>>({})
export const agentRuntimeStatusAtom = atom<Record<string, AgentRuntimeStatus>>({})
export const agentRuntimeEventsAtom = atom<RuntimeEventState>({})

/**
 * 按 threadId 切片订阅 runtime events。selectAtom + Object.is 比较：
 * appendRuntimeEvent 对未变 threadId 保留 value 引用 → 未变线程的组件不 re-render。
 */
export const agentRuntimeEventsFamily = atomFamily((threadId: string) =>
  selectAtom(agentRuntimeEventsAtom, (state) => state[threadId]),
)
export const agentPendingInteractiveAtom = atom<Record<string, AgentPendingInteractiveState>>({})
export const agentMessageQueueAtom = atom<Record<string, AgentMessageQueueSnapshot>>({})
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
