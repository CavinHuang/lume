import * as React from 'react'
import { useSetAtom } from 'jotai'
import { agentInputDraftAtom, agentInputHistoryAtom, agentRuntimeEventsAtom } from '@/atoms'
import { removeRuntimeEvents } from '@/hooks/runtime-event-state'
import { threadMessagesCache } from '@/components/agent/thread-messages-cache'
import { removeDraft, removeHistory } from '@/lib/agent-input-draft-state'

/**
 * 线程移入回收站/永久删除/随项目数据删除时的渲染端状态统一释放。
 *
 * 所有移除路径必须走这里而不是手拼子集：draft/history 是 atomWithStorage
 * （localStorage，跨重启残留），runtimeEvents/messagesCache 是会话期内存驻留，
 * 漏清任何一项都会孤儿化。恢复路径无需对称操作——重开线程时 hydrate 会重建。
 */
export function useReleaseThreadState() {
  const setDraftState = useSetAtom(agentInputDraftAtom)
  const setHistoryState = useSetAtom(agentInputHistoryAtom)
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  return React.useCallback(
    (threadId: string) => {
      setDraftState((prev) => removeDraft(prev, threadId))
      setHistoryState((prev) => removeHistory(prev, threadId))
      setRuntimeEvents((prev) => removeRuntimeEvents(prev, threadId))
      threadMessagesCache.invalidate(threadId)
    },
    [setDraftState, setHistoryState, setRuntimeEvents],
  )
}
