import { useRef, useEffect, useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { agentRunEventsAtom, agentSubagentRunsAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useScrollPositionMemory } from '@/hooks/useScrollPositionMemory'
import { getThreadMessages, getThreadRunEvents, sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentListSubagentRunsResult, type AgentMessage } from '@lume/shared'
import { cn } from '@/lib/utils'
import { hydrateRunEvents } from '@/hooks/run-event-state'
import { projectRunEventMessages, type RunEventMessageView } from './run-event-message-projection'
import { RunEventContentBlock } from './RunEventContentBlock'

interface AgentMessagesProps {
  threadId: string
  streaming: boolean
  onOpenThreadFile?: (path: string) => void
}

function isNearBottom(el: HTMLElement | null): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100
}

export function reconcileUserMessageVersions(
  messages: RunEventMessageView[],
  visibleThreadMessages: AgentMessage[],
): RunEventMessageView[] {
  const visibleUsers = visibleThreadMessages.filter((message) => message.role === 'user')
  if (visibleUsers.length === 0) return messages
  const usedVisibleIds = new Set<string>()

  return messages.map((message) => {
    if (message.type === 'user') {
      if (message.messageId) {
        return message
      }

      const visible = visibleUsers.find((item) => (
        !usedVisibleIds.has(item.id)
        && item.content === message.text
        && Math.abs(item.createdAt - Date.parse(message.createdAt)) < 10_000
      )) ?? visibleUsers.find((item) => !usedVisibleIds.has(item.id) && item.content === message.text)

      if (visible) {
        usedVisibleIds.add(visible.id)
        return {
          ...message,
          id: visible.id,
          messageId: visible.id,
          versionGroupId: visible.versionGroupId,
          versionIndex: visible.versionIndex,
          versionCount: visible.versionCount,
        }
      }
      return message
    }

    return message
  })
}

export function AgentMessages({ threadId, streaming, onOpenThreadFile }: AgentMessagesProps) {
  const liveRunEvents = useAtomValue(agentRunEventsAtom)[threadId]?.events ?? []
  const setRunEvents = useSetAtom(agentRunEventsAtom)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevThreadIdRef = useRef(threadId)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const loadedThreadsRef = useRef<Set<string>>(new Set())
  const loadedRunEventThreadsRef = useRef<Set<string>>(new Set())
  const wasNearBottomRef = useRef(true)
  const prevStreamingRef = useRef(streaming)
  const pendingRestoreThreadIdRef = useRef<string | null>(threadId)
  const restoreVersionRef = useRef(0)
  const threadRestoreRafRef = useRef<number | null>(null)
  const contentRestoreRafRef = useRef<number | null>(null)
  const initialBottomFollowCleanupRef = useRef<(() => void) | null>(null)
  const shouldFollowInitialBottomRef = useRef(false)
  const suppressProgrammaticSaveRef = useRef(false)
  const userScrollIntentRef = useRef(false)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const [visibleThreadMessages, setVisibleThreadMessages] = useState<AgentMessage[]>([])

  const { save, restore, hasSavedPosition } = useScrollPositionMemory()
  const projectedMessages = useMemo(() => projectRunEventMessages(liveRunEvents), [liveRunEvents])
  const liveMessages = useMemo(
    () => reconcileUserMessageVersions(projectedMessages, visibleThreadMessages),
    [projectedMessages, visibleThreadMessages],
  )
  const userVersionRefreshKey = useMemo(
    () => projectedMessages
      .filter((message) => message.type === 'user')
      .map((message) => `${message.messageId ?? ''}:${message.createdAt}:${message.text}`)
      .join('|'),
    [projectedMessages],
  )
  const followSignal = JSON.stringify(liveMessages.at(-1) ?? null)
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
    initialBottomFollowCleanupRef.current?.()
    initialBottomFollowCleanupRef.current = null
    shouldFollowInitialBottomRef.current = false
    suppressProgrammaticSaveRef.current = false
    userScrollIntentRef.current = false
  }, [])
  const startInitialBottomFollow = useCallback(() => {
    const scrollElement = getScrollElement()
    const containerElement = containerRef.current
    if (!scrollElement || !containerElement) return

    initialBottomFollowCleanupRef.current?.()
    shouldFollowInitialBottomRef.current = true
    suppressProgrammaticSaveRef.current = true

    let rafId: number | null = null
    let frameCount = 0
    let stableFrames = 0
    let lastHeight = scrollElement.scrollHeight

    const syncToBottom = () => {
      scrollElement.scrollTop = scrollElement.scrollHeight
      wasNearBottomRef.current = true
      setShowJumpToBottom(false)
    }

    const stopFollowing = (saveFinalPosition = true) => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      observer.disconnect()
      window.clearTimeout(timeoutId)
      scrollElement.removeEventListener('wheel', stopForUserScroll)
      scrollElement.removeEventListener('touchstart', stopForUserScroll)
      scrollElement.removeEventListener('pointerdown', stopForUserScroll)
      initialBottomFollowCleanupRef.current = null
      shouldFollowInitialBottomRef.current = false
      suppressProgrammaticSaveRef.current = false
      if (saveFinalPosition) {
        save(threadId, scrollElement)
      }
    }

    const stopForUserScroll = () => {
      userScrollIntentRef.current = true
      stopFollowing(true)
    }

    const tick = () => {
      if (!shouldFollowInitialBottomRef.current) {
        stopFollowing()
        return
      }

      const nextHeight = scrollElement.scrollHeight
      if (nextHeight !== lastHeight) {
        lastHeight = nextHeight
        stableFrames = 0
      } else {
        stableFrames += 1
      }

      syncToBottom()
      frameCount += 1

      if ((frameCount >= 90 && stableFrames >= 12) || frameCount >= 300) {
        stopFollowing()
        return
      }

      rafId = requestAnimationFrame(tick)
    }

    const observer = new ResizeObserver(() => {
      stableFrames = 0
      lastHeight = scrollElement.scrollHeight
      syncToBottom()
    })

    observer.observe(containerElement)
    scrollElement.addEventListener('wheel', stopForUserScroll, { passive: true })
    scrollElement.addEventListener('touchstart', stopForUserScroll, { passive: true })
    scrollElement.addEventListener('pointerdown', stopForUserScroll, { passive: true })
    const timeoutId = window.setTimeout(() => {
      stopFollowing()
    }, 5000)

    initialBottomFollowCleanupRef.current = () => {
      stopFollowing(false)
    }
    rafId = requestAnimationFrame(tick)
  }, [getScrollElement, save, threadId])
  const restoreCurrentThread = useCallback(() => {
    const scrollElement = getScrollElement()
    if (shouldFollowInitialBottomRef.current && scrollElement && liveMessages.length > 0) {
      startInitialBottomFollow()
      return
    }
    const restored = restore(threadId, scrollElement)
    if (!restored && scrollElement && liveMessages.length > 0) {
      startInitialBottomFollow()
      return
    }
    wasNearBottomRef.current = isNearBottom(scrollElement)
    setShowJumpToBottom(!wasNearBottomRef.current)
  }, [getScrollElement, liveMessages.length, restore, startInitialBottomFollow, threadId])
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' })
    wasNearBottomRef.current = true
    setShowJumpToBottom(false)

    const scrollElement = getScrollElement()
    if (scrollElement) {
      requestAnimationFrame(() => save(threadId, scrollElement))
    }
  }, [getScrollElement, save, threadId])

  // 首次访问线程时拉取 subagent runs
  useEffect(() => {
    if (loadedThreadsRef.current.has(threadId)) return
    loadedThreadsRef.current.add(threadId)
    sidecarCall<AgentListSubagentRunsResult>(AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS, { ownerThreadId: threadId })
      .then((r) => {
        if (!r.runs?.length) return
        setSubagentRuns((prev) => ({ ...prev, [threadId]: r.runs }))
      })
      .catch((err) => console.error('[AgentMessages] 加载 subagent runs 失败:', err))
  }, [threadId, setSubagentRuns])

  useEffect(() => {
    if (liveRunEvents.length > 0 || loadedRunEventThreadsRef.current.has(threadId)) return
    loadedRunEventThreadsRef.current.add(threadId)
    getThreadRunEvents(threadId)
      .then((result) => {
        setRunEvents((prev) => hydrateRunEvents(prev, result))
      })
      .catch((err) => {
        console.error('[AgentMessages] 加载 run events 失败:', err)
        loadedRunEventThreadsRef.current.delete(threadId)
      })
  }, [liveRunEvents.length, setRunEvents, threadId])

  useEffect(() => {
    getThreadMessages(threadId)
      .then((messages) => setVisibleThreadMessages(messages))
      .catch((err) => console.error('[AgentMessages] 加载线程消息失败:', err))
  }, [threadId, userVersionRefreshKey])

  useEffect(() => {
    const scrollElement = getScrollElement()
    if (!scrollElement) return

    const markUserScrollIntent = () => {
      userScrollIntentRef.current = true
    }

    const handleScroll = () => {
      const nearBottom = isNearBottom(scrollElement)
      wasNearBottomRef.current = nearBottom
      setShowJumpToBottom(!nearBottom)
      if (suppressProgrammaticSaveRef.current) return
      if (pendingRestoreThreadIdRef.current === threadId) return
      if (!userScrollIntentRef.current) return
      save(threadId, scrollElement)
    }

    const nearBottom = isNearBottom(scrollElement)
    wasNearBottomRef.current = nearBottom
    setShowJumpToBottom(!nearBottom)
    scrollElement.addEventListener('wheel', markUserScrollIntent, { passive: true })
    scrollElement.addEventListener('touchstart', markUserScrollIntent, { passive: true })
    scrollElement.addEventListener('pointerdown', markUserScrollIntent, { passive: true })
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollElement.removeEventListener('wheel', markUserScrollIntent)
      scrollElement.removeEventListener('touchstart', markUserScrollIntent)
      scrollElement.removeEventListener('pointerdown', markUserScrollIntent)
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [getScrollElement, save, threadId])

  // 切换 thread 时保存/恢复滚动位置
  useLayoutEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      cancelScheduledRestores()
      userScrollIntentRef.current = false
      restoreVersionRef.current += 1
      const restoreVersion = restoreVersionRef.current
      prevThreadIdRef.current = threadId
      shouldFollowInitialBottomRef.current = !hasSavedPosition(threadId)
      pendingRestoreThreadIdRef.current = threadId
      threadRestoreRafRef.current = requestAnimationFrame(() => {
        threadRestoreRafRef.current = null
        if (
          restoreVersionRef.current !== restoreVersion ||
          pendingRestoreThreadIdRef.current !== threadId
        ) {
          return
        }
        const hasMessages = liveMessages.length > 0
        restoreCurrentThread()
        if (hasMessages && !shouldFollowInitialBottomRef.current) {
          pendingRestoreThreadIdRef.current = null
        }
      })
    }
  }, [cancelScheduledRestores, hasSavedPosition, liveMessages.length, restoreCurrentThread, threadId])

  useLayoutEffect(() => {
    if (pendingRestoreThreadIdRef.current !== threadId || liveMessages.length === 0) return

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
      if (!shouldFollowInitialBottomRef.current) {
        pendingRestoreThreadIdRef.current = null
      }
    })
  }, [liveMessages.length, restoreCurrentThread, threadId])

  useEffect(() => {
    if (!shouldFollowInitialBottomRef.current) return
    if (liveMessages.length === 0) return
    startInitialBottomFollow()
    pendingRestoreThreadIdRef.current = null
  }, [liveMessages.length, startInitialBottomFollow])

  useEffect(() => cancelScheduledRestores, [cancelScheduledRestores])

  // 流式输出时根据更新前的滚动状态决定是否继续跟随到底部
  useLayoutEffect(() => {
    const wasStreaming = prevStreamingRef.current
    prevStreamingRef.current = streaming

    if ((streaming || wasStreaming) && wasNearBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom(streaming ? 'smooth' : 'auto'))
    }
  }, [followSignal, scrollToBottom, streaming])

  const items: React.ReactNode[] = []
  for (let i = 0; i < liveMessages.length; i++) {
    const msg = liveMessages[i]
    items.push(
      <RunEventContentBlock
        key={`run-event-${msg.id}`}
        message={msg}
        animate={streaming && i === liveMessages.length - 1}
        threadId={threadId}
        onOpenThreadFile={onOpenThreadFile}
      />
    )
  }
  const hasRenderableMessages = liveMessages.length > 0

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div
        ref={containerRef}
        className={cn(
          'min-h-full w-full px-3 py-5',
          !hasRenderableMessages ? 'flex items-center justify-center' : 'space-y-7'
        )}
      >
        {!hasRenderableMessages ? (
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
      {showJumpToBottom && hasRenderableMessages && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-4 right-5 z-20 inline-flex size-9 items-center justify-center rounded-full border border-[#e2e5ef] bg-white text-[#667085] shadow-[0_8px_22px_rgba(27,31,45,0.12)] transition-colors hover:border-[#c9cdfb] hover:text-[#625cff]"
          aria-label="回到底部"
          title="回到底部"
        >
          <ArrowDown size={17} strokeWidth={2.2} />
        </button>
      )}
    </ScrollArea>
  )
}
