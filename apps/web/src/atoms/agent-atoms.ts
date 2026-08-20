import { atom, type Atom, type WritableAtom } from 'jotai'
import { atomFamily, atomWithStorage, selectAtom } from 'jotai/utils'
import type { AgentBrowserAttachment, AgentDiffCommentAttachment, AgentThreadMeta, AgentRuntimeStatus, AgentPendingInteractiveState, SubagentRunRecord, AgentListSubagentWorkResult, PlanModePhaseChangedEvent, AgentSendInput, AgentMessageQueueSnapshot } from '@lume/shared'
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

type StreamingState = 'idle' | 'streaming' | 'errored'
export const agentStreamingStatesAtom = atom<Record<string, StreamingState>>({})
export const agentStreamingStatesFamily = createThreadSliceFamily(agentStreamingStatesAtom)
/**
 * 队列因中断(STOP)暂停的 per-thread 标记。run.cancelled 且队列非空时置 true;
 * 任何 dispatch(requeue/retry/send)或队列清空时置 false。驱动 Resume 横幅。
 */
export const agentQueueInterruptedAtom = atom<Record<string, boolean>>({})
export const agentQueueInterruptedFamily = createThreadSliceFamily(agentQueueInterruptedAtom)
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

type AgentThreadPermissionMode = NonNullable<AgentSendInput['permissionMode']>
/**
 * 每会话手动权限模式覆盖：按 threadId 落 localStorage。
 * 否则 renderer 重新加载后丢失，重进会话会被 plan phase 或全局默认覆盖（issue #28）。
 */
export const agentThreadPermissionModesAtom = atomWithStorage<Record<string, AgentThreadPermissionMode>>(
  'agent-thread-permission-modes',
  {},
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

export const agentDiffCommentDraftsAtom = atomWithStorage<Record<string, AgentDiffCommentAttachment[]>>(
  'agent-diff-comment-drafts',
  {},
)
export const agentDiffCommentDraftsFamily = createThreadSliceFamily(agentDiffCommentDraftsAtom)

export const agentBrowserAttachmentsAtom = atomWithStorage<Record<string, AgentBrowserAttachment[]>>(
  'agent-browser-attachments',
  {},
)
export const agentBrowserAttachmentsFamily = createThreadSliceFamily(agentBrowserAttachmentsAtom)

export const agentInputHistoryAtom = atomWithStorage<Record<string, AgentInputDraftJSON[]>>(
  'agent-input-history',
  {},
)
export const agentInputHistoryFamily = createThreadSliceFamily(agentInputHistoryAtom)

/**
 * 队列项图片附件的预览 URL(renderer 本地 objectURL 映射)。
 * key = messageAttachment.id,value = objectURL。
 * 不进 sidecar/不持久化;提交时填、队列项删除时 revoke+清。刷新丢失 → 队列行降级为无缩略。
 */
export const queuedAttachmentPreviewUrlAtom = atom<Record<string, string>>({})
