/**
 * 任务通知提示音的全局边沿监听：
 * 会话从 streaming 进入 idle/errored（完成或出错）时播放提示音。
 * 挂载一次（AppShell），权限确认等“需要用户介入”的时机在事件入口处直接调用播放。
 */
import { useAtomValue } from 'jotai'
import { useEffect, useRef } from 'react'
import { agentStreamingStatesAtom } from '@/atoms'
import { playTaskNotificationSound } from '@/lib/notification-sound'

export function useTaskNotificationSound(): void {
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const previousRef = useRef<Record<string, string>>({})

  useEffect(() => {
    for (const [threadId, state] of Object.entries(streamingStates)) {
      const previous = previousRef.current[threadId]
      if (previous === 'streaming' && (state === 'idle' || state === 'errored')) {
        void playTaskNotificationSound()
      }
    }
    previousRef.current = { ...streamingStates }
  }, [streamingStates])
}
