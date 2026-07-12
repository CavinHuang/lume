import { atom, type Atom, type WritableAtom } from 'jotai'
import { atomFamily, atomWithStorage, selectAtom } from 'jotai/utils'
import type { AgentThreadMeta, AgentRuntimeStatus, AgentPendingInteractiveState, SubagentRunRecord, AgentListSubagentWorkResult, PlanModePhaseChangedEvent, AgentSendInput, AgentMessageQueueSnapshot } from '@lume/shared'
import type { RuntimeEventState } from '@/hooks/runtime-event-state'
import type { DesktopActionVisualOverlayState } from '@/hooks/desktop-action-visual-state'
import type { AgentInputDraftJSON } from '@/lib/agent-input-draft-state'

/**
 * 按 threadId 切片订阅一个全局 Record atom。
 * 返回 atomFamily：每个 threadId 一个 selectAtom，selector 返回 state[threadId]，
 * 经 Object.is 比较。依赖写入侧不可变展开（{ ...prev, [id]: next }）保留未变
 * threadId 的 value 引用 —— 否则 selectAtom 无法跳过重渲染。
 * 返回 T | undefined；调用方保留既有 `?? default` 语义。
 */
export function createThreadSliceFamily<T>(
  rootAtom: Atom<Record<string, T>> | WritableAtom<Record<string, T>, unknown[], unknown>,
) {
  return atomFamily((threadId: string) =>
    selectAtom(rootAtom, (state) => state[threadId]),
  )
}

export const agentThreadsAtom = atom<AgentThreadMeta[]>([])
export const currentThreadIdAtom = atom<string | null>(null)

export type StreamingState = 'idle' | 'streaming' | 'errored'
export const agentStreamingStatesAtom = atom<Record<string, StreamingState>>({})
export const agentStreamingStatesFamily = createThreadSliceFamily(agentStreamingStatesAtom)
export const agentRuntimeStatusAtom = atom<Record<string, AgentRuntimeStatus>>({})
export const agentRuntimeStatusFamily = createThreadSliceFamily(agentRuntimeStatusAtom)
export const agentRuntimeEventsAtom = atom<RuntimeEventState>({})
export const desktopActionVisualAtom = atom<DesktopActionVisualOverlayState | null>(null)

/**
 * 按 threadId 切片订阅 runtime events。selectAtom + Object.is 比较：
 * appendRuntimeEvent 对未变 threadId 保留 value 引用 → 未变线程的组件不 re-render。
 */
export const agentRuntimeEventsFamily = atomFamily((threadId: string) =>
  selectAtom(agentRuntimeEventsAtom, (state) => state[threadId]),
)
export const agentPendingInteractiveAtom = atom<Record<string, AgentPendingInteractiveState>>({})
export const agentPendingInteractiveFamily = createThreadSliceFamily(agentPendingInteractiveAtom)
export const agentMessageQueueAtom = atom<Record<string, AgentMessageQueueSnapshot>>({})
export const agentSubagentRunsAtom = atom<Record<string, SubagentRunRecord[]>>({})
export const agentSubagentRunsFamily = createThreadSliceFamily(agentSubagentRunsAtom)
/** Persistent work-loop snapshot, keyed by parent thread. Kept separate during v1 migration. */
export const agentSubagentWorkAtom = atom<Record<string, AgentListSubagentWorkResult>>({})
export const agentSubagentWorkFamily = createThreadSliceFamily(agentSubagentWorkAtom)

export const agentPlanModePhaseAtom = atom<Record<string, PlanModePhaseChangedEvent>>({})
export const agentPlanModePhaseFamily = createThreadSliceFamily(agentPlanModePhaseAtom)
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

/**
 * 输入草稿 / 历史：按 threadId 分桶，落 localStorage。
 * - draft：每会话 1 份未发送草稿（富文本 JSON）。
 * - history：每会话已发送输入列表（最新在前，≤ AGENT_INPUT_HISTORY_LIMIT）。
 * 只读 family 用 createThreadSliceFamily（selectAtom）；写入走 root atom + lib 纯函数
 * （见 AgentInput / ArchiveSettings 调用方）。
 */
export type { AgentInputDraftJSON }

export const agentInputDraftAtom = atomWithStorage<Record<string, AgentInputDraftJSON>>(
  'agent-input-draft',
  {},
)
export const agentInputDraftFamily = createThreadSliceFamily(agentInputDraftAtom)

export const agentInputHistoryAtom = atomWithStorage<Record<string, AgentInputDraftJSON[]>>(
  'agent-input-history',
  {},
)
export const agentInputHistoryFamily = createThreadSliceFamily(agentInputHistoryAtom)
