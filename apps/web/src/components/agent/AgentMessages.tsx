import { useRef, useEffect, useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { agentRuntimeEventsAtom, agentSubagentRunsAtom } from '@/atoms'
import { getThreadMessages, getThreadRuntimeEvents, sidecarCall } from '@/lib/desktop-api'
import {
  AGENT_IPC_CHANNELS,
  type AgentListSubagentRunsResult,
  type AgentMessage,
} from '@lume/shared'
import { cn } from '@/lib/utils'
import { hydrateRuntimeEvents } from '@/hooks/runtime-event-state'
import { projectRuntimeEventMessages } from './runtime-event-message-projection'
import { RuntimeEventContentBlock } from './RuntimeEventContentBlock'
import {
  collectNewRuntimeMessageIds,
  collectRuntimeMessageIds,
  getPreservedScrollTopAfterResize,
  isNearScrollBottom,
  projectVisibleThreadMessages,
  reconcileUserMessageVersions,
  shouldAutoScrollAfterUserScroll,
} from './agent-message-state'

interface AgentMessagesProps {
  threadId: string
  streaming: boolean
  onOpenThreadFile?: (path: string) => void
  onOpenMemorySource?: (path: string) => void
}

export function AgentMessages({ threadId, streaming, onOpenThreadFile, onOpenMemorySource }: AgentMessagesProps) {
  const runtimeEvents = useAtomValue(agentRuntimeEventsAtom)[threadId]?.events ?? []
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const prevThreadIdRef = useRef(threadId)
  const previousMessageIdsRef = useRef<{ threadId: string; ids: Set<string> }>({ threadId, ids: new Set() })
  const previousScrollTopRef = useRef(0)
  const suspendResizeCompensationUntilRef = useRef(0)
  const shouldAutoScrollRef = useRef(true)
  const showScrollButtonRef = useRef(false)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const loadedThreadsRef = useRef<Set<string>>(new Set())
  const loadedRuntimeEventThreadsRef = useRef<Set<string>>(new Set())
  const [visibleThreadMessages, setVisibleThreadMessages] = useState<AgentMessage[]>([])
  const [showScrollButton, setShowScrollButton] = useState(false)
  const projectedMessages = useMemo(() => (
    runtimeEvents.length > 0
      ? projectRuntimeEventMessages(runtimeEvents)
      : projectVisibleThreadMessages(visibleThreadMessages)
  ), [runtimeEvents, visibleThreadMessages])
  const liveMessages = useMemo(
    () => reconcileUserMessageVersions(projectedMessages, visibleThreadMessages),
    [projectedMessages, visibleThreadMessages],
  )
  const newMessageIds = useMemo(() => {
    const previousIds = previousMessageIdsRef.current.threadId === threadId
      ? previousMessageIdsRef.current.ids
      : new Set<string>()
    return collectNewRuntimeMessageIds(previousIds, liveMessages)
  }, [liveMessages, threadId])
  const userVersionRefreshKey = useMemo(
    () => projectedMessages
      .filter((message) => message.type === 'user')
      .map((message) => `${message.messageId ?? ''}:${message.createdAt}:${message.text}`)
      .join('|'),
    [projectedMessages],
  )
  const setScrollButtonVisible = useCallback((visible: boolean) => {
    if (showScrollButtonRef.current === visible) return
    showScrollButtonRef.current = visible
    setShowScrollButton(visible)
  }, [])
  const suspendScrollCompensationForUserResize = useCallback(() => {
    shouldAutoScrollRef.current = false
    suspendResizeCompensationUntilRef.current = performance.now() + 800
  }, [])
  const scrollMessagesToBottom = useCallback((animation: 'instant' | 'smooth' = 'smooth') => {
    const container = scrollContainerRef.current
    if (!container) return undefined

    shouldAutoScrollRef.current = true

    const scrollOnce = () => {
      if (animation === 'smooth' && typeof container.scrollTo === 'function') {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      } else {
        container.scrollTop = container.scrollHeight
      }
      previousScrollTopRef.current = container.scrollTop
      setScrollButtonVisible(false)
    }

    scrollOnce()

    if (animation === 'smooth') return undefined

    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      scrollOnce()
      secondFrame = requestAnimationFrame(scrollOnce)
    })

    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [setScrollButtonVisible])

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
    if (runtimeEvents.length > 0 || loadedRuntimeEventThreadsRef.current.has(threadId)) return
    loadedRuntimeEventThreadsRef.current.add(threadId)
    getThreadRuntimeEvents(threadId)
      .then((result) => {
        setRuntimeEvents((prev) => hydrateRuntimeEvents(prev, result))
      })
      .catch((err) => {
        console.error('[AgentMessages] 加载 runtime events 失败:', err)
        loadedRuntimeEventThreadsRef.current.delete(threadId)
      })
  }, [runtimeEvents.length, setRuntimeEvents, threadId])

  useEffect(() => {
    getThreadMessages(threadId)
      .then((messages) => setVisibleThreadMessages(messages))
      .catch((err) => console.error('[AgentMessages] 加载线程消息失败:', err))
  }, [threadId, userVersionRefreshKey])

  useEffect(() => {
    previousMessageIdsRef.current = {
      threadId,
      ids: collectRuntimeMessageIds(liveMessages),
    }
  }, [liveMessages, threadId])

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const currentScrollTop = container.scrollTop
    const nearBottom = isNearScrollBottom(container)
    shouldAutoScrollRef.current = shouldAutoScrollAfterUserScroll({
      currentScrollTop,
      previousScrollTop: previousScrollTopRef.current,
      nearBottom,
    })
    previousScrollTopRef.current = currentScrollTop
    setScrollButtonVisible(!nearBottom && liveMessages.length > 0)
  }, [liveMessages.length, setScrollButtonVisible])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const content = contentRef.current
    if (!container || !content) return

    let previousScrollHeight = container.scrollHeight
    let previousContentHeight = content.getBoundingClientRect().height
    const resizeObserver = new ResizeObserver(() => {
      const nextContentHeight = content.getBoundingClientRect().height
      if (nextContentHeight === previousContentHeight) return
      previousContentHeight = nextContentHeight

      const nextScrollHeight = container.scrollHeight
      if (performance.now() < suspendResizeCompensationUntilRef.current) {
        previousScrollTopRef.current = container.scrollTop
        previousScrollHeight = nextScrollHeight
        setScrollButtonVisible(!isNearScrollBottom(container) && liveMessages.length > 0)
        return
      }

      if (shouldAutoScrollRef.current) {
        container.scrollTop = container.scrollHeight
      } else {
        container.scrollTop = getPreservedScrollTopAfterResize({
          currentScrollTop: container.scrollTop,
          previousScrollHeight,
          nextScrollHeight,
        })
      }
      previousScrollTopRef.current = container.scrollTop
      previousScrollHeight = container.scrollHeight
      setScrollButtonVisible(!isNearScrollBottom(container) && liveMessages.length > 0)
    })

    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [liveMessages.length, setScrollButtonVisible])

  useLayoutEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId
      shouldAutoScrollRef.current = true
      return scrollMessagesToBottom('instant')
    }

    if (shouldAutoScrollRef.current && liveMessages.length > 0) {
      return scrollMessagesToBottom('instant')
    }
  }, [liveMessages.length, scrollMessagesToBottom, threadId])

  const items: React.ReactNode[] = []
  for (let i = 0; i < liveMessages.length; i++) {
    const msg = liveMessages[i]
    const activeStreamingMessage = streaming && i === liveMessages.length - 1
    items.push(
      <RuntimeEventContentBlock
        key={`runtime-event-${msg.id}`}
        message={msg}
        animate={activeStreamingMessage && newMessageIds.has(msg.id)}
        streaming={activeStreamingMessage}
        threadId={threadId}
        onOpenThreadFile={onOpenThreadFile}
        onOpenMemorySource={onOpenMemorySource}
        onUserResizeStart={suspendScrollCompensationForUserResize}
      />
    )
  }
  const hasRenderableMessages = liveMessages.length > 0

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="h-full w-full overflow-y-auto"
      >
        <div
          ref={contentRef}
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
            </>
          )}
        </div>
      </div>
      {showScrollButton && hasRenderableMessages && (
        <button
          type="button"
          onClick={() => scrollMessagesToBottom('smooth')}
          className="absolute bottom-4 right-5 z-20 inline-flex size-9 items-center justify-center rounded-full border border-[#e2e5ef] bg-white text-[#667085] shadow-[0_8px_22px_rgba(27,31,45,0.12)] transition-colors hover:border-[#c9cdfb] hover:text-[#625cff]"
          aria-label="回到底部"
          title="回到底部"
        >
          <ArrowDown size={17} strokeWidth={2.2} />
        </button>
      )}
    </div>
  )
}
