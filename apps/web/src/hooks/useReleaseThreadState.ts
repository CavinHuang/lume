import * as React from 'react'
import { useSetAtom } from 'jotai'
import {
  agentBrowserAttachmentsAtom,
  agentDiffCommentDraftsAtom,
  agentInputDraftAtom,
  agentInputHistoryAtom,
  agentMessageQueueAtom,
  agentPendingInteractiveAtom,
  agentPlanModePhaseAtom,
  agentQueueInterruptedAtom,
  agentRuntimeEventsAtom,
  agentRuntimeStatusAtom,
  agentStreamingStatesAtom,
  agentSubagentRunsAtom,
  agentThreadPermissionModesAtom,
  queuedAttachmentPreviewUrlAtom,
} from '@/atoms'
import { removeRuntimeEvents } from '@/hooks/runtime-event-state'
import { threadMessagesCache } from '@/components/agent/thread-messages-cache'
import { removeDraft, removeHistory } from '@/lib/agent-input-draft-state'
import { releaseThreadLifecycleState } from './useGlobalAgentListeners'

function removeKey<T>(prev: Record<string, T>, threadId: string): Record<string, T> {
  if (!(threadId in prev)) return prev
  const next = { ...prev }
  delete next[threadId]
  return next
}

/**
 * 线程移入回收站/永久删除/随项目数据删除时的渲染端状态统一释放。
 *
 * 所有移除路径必须走这里而不是手拼子集：draft/history 是 atomWithStorage
 * （localStorage，跨重启残留），runtimeEvents/messagesCache 是会话期内存驻留，
 * 漏清任何一项都会孤儿化。恢复路径无需对称操作——重开线程时 hydrate 会重建
 * （permissionModes/diffCommentDrafts/browserAttachments 为草稿类数据，放弃
 * 与 draft 同语义；内存状态残留反而会让恢复线程显示陈旧的运行中/Resume 横幅）。
 */
export function useReleaseThreadState() {
  const setDraftState = useSetAtom(agentInputDraftAtom)
  const setHistoryState = useSetAtom(agentInputHistoryAtom)
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setRuntimeStatus = useSetAtom(agentRuntimeStatusAtom)
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const setMessageQueues = useSetAtom(agentMessageQueueAtom)
  const setQueueInterrupted = useSetAtom(agentQueueInterruptedAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const setPlanModePhase = useSetAtom(agentPlanModePhaseAtom)
  const setThreadPermissionModes = useSetAtom(agentThreadPermissionModesAtom)
  const setDiffCommentDrafts = useSetAtom(agentDiffCommentDraftsAtom)
  const setBrowserAttachments = useSetAtom(agentBrowserAttachmentsAtom)
  const setQueuedAttachmentPreviewUrls = useSetAtom(queuedAttachmentPreviewUrlAtom)
  return React.useCallback(
    (threadId: string) => {
      setDraftState((prev) => removeDraft(prev, threadId))
      setHistoryState((prev) => removeHistory(prev, threadId))
      setRuntimeEvents((prev) => removeRuntimeEvents(prev, threadId))
      setStreamingStates((prev) => removeKey(prev, threadId))
      setRuntimeStatus((prev) => removeKey(prev, threadId))
      setPendingInteractive((prev) => removeKey(prev, threadId))
      setQueueInterrupted((prev) => removeKey(prev, threadId))
      setSubagentRuns((prev) => removeKey(prev, threadId))
      setPlanModePhase((prev) => removeKey(prev, threadId))
      setThreadPermissionModes((prev) => removeKey(prev, threadId))
      setDiffCommentDrafts((prev) => removeKey(prev, threadId))
      setBrowserAttachments((prev) => removeKey(prev, threadId))
      // 队列删除时顺带收集该线程排队消息的附件 id，用于下方 revoke 预览 objectURL。
      // updater 内只收集不 revoke（保持纯净）；id 重复 push 无害（下方按 prev 幂等去重）。
      const removedAttachmentIds: string[] = []
      setMessageQueues((prev) => {
        for (const message of prev[threadId]?.queuedMessages ?? []) {
          for (const attachment of message.messageAttachments ?? []) {
            removedAttachmentIds.push(attachment.id)
          }
        }
        return removeKey(prev, threadId)
      })
      const urlsToRevoke: string[] = []
      setQueuedAttachmentPreviewUrls((prev) => {
        if (!removedAttachmentIds.some((id) => id in prev)) return prev
        const next = { ...prev }
        for (const id of removedAttachmentIds) {
          const url = next[id]
          if (url) {
            urlsToRevoke.push(url)
            delete next[id]
          }
        }
        return next
      })
      for (const url of urlsToRevoke) URL.revokeObjectURL(url)
      releaseThreadLifecycleState(threadId)
      threadMessagesCache.invalidate(threadId)
    },
    [
      setDraftState, setHistoryState, setRuntimeEvents, setStreamingStates, setRuntimeStatus,
      setPendingInteractive, setMessageQueues, setQueueInterrupted, setSubagentRuns,
      setPlanModePhase, setThreadPermissionModes,
      setDiffCommentDrafts, setBrowserAttachments, setQueuedAttachmentPreviewUrls,
    ],
  )
}
