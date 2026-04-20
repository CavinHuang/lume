import { useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import type { SDKMessage } from '@lume/shared'
import { SDKContentBlock } from './SDKContentBlock'
import { useSetAtom } from 'jotai'
import { agentSubagentRunsAtom, agentSDKMessagesAtom, agentSubagentMessagesAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useScrollPositionMemory } from '@/hooks/useScrollPositionMemory'
import { getThreadSDKMessages } from '@/lib/desktop-api'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentListSubagentRunsResult } from '@lume/shared'
import { cn } from '@/lib/utils'

interface AgentMessagesProps {
  threadId: string
  sdkMessages: SDKMessage[]
  streaming: boolean
}

function isNearBottom(el: HTMLElement | null): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100
}

function getFollowSignal(messages: SDKMessage[]): string {
  const lastMessage = messages.at(-1)
  if (!lastMessage) return 'empty'

  return JSON.stringify({
    length: messages.length,
    type: lastMessage.type,
    uuid: (lastMessage as { uuid?: string }).uuid ?? null,
    message: 'message' in lastMessage ? lastMessage.message : null,
  })
}

export function AgentMessages({ threadId, sdkMessages, streaming }: AgentMessagesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevThreadIdRef = useRef(threadId)
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const setSubagentMessages = useSetAtom(agentSubagentMessagesAtom)
  const loadedThreadsRef = useRef<Set<string>>(new Set())
  const wasNearBottomRef = useRef(true)
  const pendingRestoreThreadIdRef = useRef<string | null>(threadId)
  const restoreVersionRef = useRef(0)
  const threadRestoreRafRef = useRef<number | null>(null)
  const contentRestoreRafRef = useRef<number | null>(null)

  const { save, restore } = useScrollPositionMemory()
  const followSignal = getFollowSignal(sdkMessages)
  const getScrollElement = useCallback(() => {
    const viewport = containerRef.current?.closest('[data-slot="scroll-area-viewport"]')
    return viewport instanceof HTMLDivElement ? viewport : null
  }, [])
  const cancelScheduledRestores = useCallback(() => {
    if (threadRestoreRafRef.current !== null) {
      cancelAnimationFrame(threadRestoreRafRef.current)
      threadRestoreRafRef.current = null
    }
    if (contentRestoreRafRef.current !== null) {
      cancelAnimationFrame(contentRestoreRafRef.current)
      contentRestoreRafRef.current = null
    }
  }, [])
  const restoreCurrentThread = useCallback(() => {
    const scrollElement = getScrollElement()
    restore(threadId, scrollElement)
    wasNearBottomRef.current = isNearBottom(scrollElement)
  }, [getScrollElement, restore, threadId])

  // 首次访问线程时拉取历史 SDK 消息 + subagent runs
  useEffect(() => {
    if (loadedThreadsRef.current.has(threadId)) return
    if (sdkMessages.length > 0) {
      loadedThreadsRef.current.add(threadId)
      return
    }
    loadedThreadsRef.current.add(threadId)
    getThreadSDKMessages(threadId)
      .then((r) => {
        const list = r.messages ?? []
        if (list.length === 0) return
        const mainMessages: SDKMessage[] = []
        const subagentByRun: Record<string, SDKMessage[]> = {}
        for (const msg of list) {
          const runId = (msg as { subagent_run_id?: string }).subagent_run_id
          if (runId) {
            ;(subagentByRun[runId] ??= []).push(msg)
          } else {
            mainMessages.push(msg)
          }
        }
        setSDKMessages((prev) => ({ ...prev, [threadId]: [...mainMessages, ...(prev[threadId] ?? [])] }))
        if (Object.keys(subagentByRun).length > 0) {
          setSubagentMessages((prev) => {
            const threadMap = { ...(prev[threadId] ?? {}) }
            for (const [runId, msgs] of Object.entries(subagentByRun)) {
              threadMap[runId] = [...(threadMap[runId] ?? []), ...msgs]
            }
            return { ...prev, [threadId]: threadMap }
          })
        }
      })
      .catch((err) => {
        console.error('[AgentMessages] 加载历史失败:', err)
        loadedThreadsRef.current.delete(threadId)
      })
    // 拉取 subagent runs（进行中的和已完成的）
    sidecarCall<AgentListSubagentRunsResult>('agent:list-subagent-runs', { ownerThreadId: threadId })
      .then((r) => {
        if (!r.runs?.length) return
        setSubagentRuns((prev) => ({ ...prev, [threadId]: r.runs }))
      })
      .catch((err) => console.error('[AgentMessages] 加载 subagent runs 失败:', err))
  }, [threadId, sdkMessages.length, setSDKMessages, setSubagentRuns])

  useEffect(() => {
    const scrollElement = getScrollElement()
    if (!scrollElement) return

    const handleScroll = () => {
      wasNearBottomRef.current = isNearBottom(scrollElement)
      save(threadId, scrollElement)
    }

    wasNearBottomRef.current = isNearBottom(scrollElement)
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [getScrollElement, save, threadId])

  // 切换 thread 时保存/恢复滚动位置
  useEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      cancelScheduledRestores()
      restoreVersionRef.current += 1
      const restoreVersion = restoreVersionRef.current
      prevThreadIdRef.current = threadId
      pendingRestoreThreadIdRef.current = threadId
      threadRestoreRafRef.current = requestAnimationFrame(() => {
        threadRestoreRafRef.current = null
        if (
          restoreVersionRef.current !== restoreVersion ||
          pendingRestoreThreadIdRef.current !== threadId
        ) {
          return
        }
        const hasMessages = sdkMessages.length > 0
        restoreCurrentThread()
        if (hasMessages) {
          pendingRestoreThreadIdRef.current = null
        }
      })
    }
  }, [cancelScheduledRestores, restoreCurrentThread, sdkMessages.length, threadId])

  useLayoutEffect(() => {
    if (pendingRestoreThreadIdRef.current !== threadId || sdkMessages.length === 0) return

    if (contentRestoreRafRef.current !== null) {
      cancelAnimationFrame(contentRestoreRafRef.current)
    }

    const restoreVersion = restoreVersionRef.current
    contentRestoreRafRef.current = requestAnimationFrame(() => {
      contentRestoreRafRef.current = null
      if (
        restoreVersionRef.current !== restoreVersion ||
        pendingRestoreThreadIdRef.current !== threadId
      ) {
        return
      }
      restoreCurrentThread()
      pendingRestoreThreadIdRef.current = null
    })
  }, [restoreCurrentThread, sdkMessages.length, threadId])

  useEffect(() => cancelScheduledRestores, [cancelScheduledRestores])

  // 流式输出时根据更新前的滚动状态决定是否继续跟随到底部
  useLayoutEffect(() => {
    if (streaming && wasNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [followSignal, streaming])

  const items: React.ReactNode[] = []
  for (let i = 0; i < sdkMessages.length; i++) {
    const msg = sdkMessages[i]
    items.push(
      <SDKContentBlock
        key={(msg as { uuid?: string }).uuid ?? `msg-${i}`}
        message={msg}
        index={i}
        animate={streaming && i === sdkMessages.length - 1}
        allMessages={sdkMessages}
        isStreaming={streaming}
        threadId={threadId}
      />
    )
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div
        ref={containerRef}
        className={cn(
          'min-h-full px-4 py-4',
          sdkMessages.length === 0 ? 'flex items-center justify-center' : 'space-y-2'
        )}
      >
        {sdkMessages.length === 0 ? (
          <div className="text-center space-y-1">
            <p className="text-foreground/50 text-sm font-medium">Agent 已就绪</p>
            <p className="text-foreground/30 text-xs">输入任务开始</p>
          </div>
        ) : (
          <>
            {items}
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </ScrollArea>
  )
}
