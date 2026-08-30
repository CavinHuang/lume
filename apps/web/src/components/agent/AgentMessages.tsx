import { useRef, useEffect, useCallback, useLayoutEffect, useMemo, useState, type TouchEventHandler, type WheelEventHandler } from 'react'
import { ArrowDown } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { agentRuntimeEventsAtom, agentRuntimeEventsFamily, agentSubagentRunsAtom } from '@/atoms'
import { getThreadMessages, getThreadRuntimeEvents, sidecarCall } from '@/lib/desktop-api'
import {
  AGENT_IPC_CHANNELS,
  type AgentListSubagentRunsResult,
  type AgentMessageAttachmentInput,
  type AgentMessage,
  type FileRef,
} from '@lume/shared'
import { cn } from '@/lib/utils'
import { hydrateRuntimeEvents } from '@/hooks/runtime-event-state'
import {
  applyRuntimeEventsIncremental,
  type ProjectionRef,
} from './runtime-event-message-projection'
import { RuntimeEventContentBlock } from './RuntimeEventContentBlock'
import { AgentHistorySelectionLayer } from './AgentHistorySelectionLayer'
import { TodoPanel } from './TodoPanel'
import { TaskProgressCapsule } from './TaskProgressCapsule'
import { ScrollMinimap, type MinimapItem } from './ScrollMinimap'
import { summarizeMessageForPreview } from '@/components/app-shell/ThreadMiniMapPopover'
import type { TodoBlockData } from './runtime-message-view'
import { threadMessagesCache } from './thread-messages-cache'
import { useBootstrapGeneralSettings, useSyncGeneralSettingsAfterPersonalize } from '@/hooks/use-general-settings'
import {
  collectNewRuntimeMessageIds,
  collectConversationMinimapItems,
  collectRuntimeMessageIds,
  getLatestUserMessageKey,
  getProgrammaticScrollHoldUntil,
  haveSameMessageIdentities,
  isNearScrollBottom,
  projectVisibleThreadMessages,
  reconcileUserMessageVersions,
  shouldApplyThreadMessagesResult,
  shouldAutoScrollAfterUserScroll,
  stabilizeRuntimeMessages,
  type ReconcileCache,
  type RuntimeMessageStabilizeCache,
} from './agent-message-state'

import { Button } from '@/components/ui/button'
interface AgentMessagesProps {
  threadId: string
  streaming: boolean
  onOpenThreadFile?: (path: string, fileRef?: FileRef) => void
  onOpenThreadImage?: (attachment: AgentMessageAttachmentInput) => void
  onOpenMemorySource?: (path: string, fileRef?: FileRef) => void
}

export function AgentMessages({ threadId, streaming, onOpenThreadFile, onOpenThreadImage, onOpenMemorySource }: AgentMessagesProps) {
  useBootstrapGeneralSettings()
  const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
  useSyncGeneralSettingsAfterPersonalize(runtimeEvents)
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const activeThreadIdRef = useRef(threadId)
  const prevThreadIdRef = useRef(threadId)
  const previousMessageIdsRef = useRef<{ threadId: string; ids: Set<string> }>({ threadId, ids: new Set() })
  const programmaticScrollUntilRef = useRef(0)
  const programmaticScrollReleaseTimeoutRef = useRef<number | null>(null)
  const scheduledBottomScrollFrameRef = useRef(0)
  const latestUserMessageKeyRef = useRef<string | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const stabilizeCacheRef = useRef<RuntimeMessageStabilizeCache>(new Map())
  const reconcileCacheRef = useRef<ReconcileCache>(new Map())
  const showScrollButtonRef = useRef(false)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const loadedThreadsRef = useRef<Set<string>>(new Set())
  const loadedRuntimeEventThreadsRef = useRef<Set<string>>(new Set())
  const [visibleThreadMessages, setVisibleThreadMessages] = useState<AgentMessage[]>([])
  const [taskCapsuleVisible, setTaskCapsuleVisible] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const projectionRef = useRef<ProjectionRef | null>(null)
  const projectedMessages = useMemo(() => {
    if (runtimeEvents.length > 0) {
      const result = applyRuntimeEventsIncremental(runtimeEvents, projectionRef.current)
      projectionRef.current = result.ref
      return result.messages
    }
    // runtimeEvents 为空（如纯历史会话，无 runtime events）：走 visibleThreadMessages 投影
    projectionRef.current = null
    return projectVisibleThreadMessages(visibleThreadMessages)
  }, [runtimeEvents, visibleThreadMessages])
  const liveMessages = useMemo(
    () => stabilizeRuntimeMessages(
      reconcileUserMessageVersions(projectedMessages, visibleThreadMessages, reconcileCacheRef.current),
      stabilizeCacheRef.current,
    ),
    [projectedMessages, visibleThreadMessages],
  )
  // 结构快照:minimap 只关心消息身份,不关心流式 token。
  // collectConversationMinimapItems 会为每个用户 turn join 复制全部 assistant 文本,
  // 流式期间 liveMessages 每 update 帧都是新引用,直接依赖会让长会话在 ~60fps 下持续全量重算。
  // 身份未变时保持旧数组引用;流式起止各刷新一次,且流式中每秒节流刷新一次——
  // 否则活跃 turn 的 preview 会整场停留在追加帧(通常为空文本,悬停显示"暂无回复")。
  // 非流式时每次变更都刷新,保持用户消息版本合并等低频更新的即时性。
  // 注意:快照只冻结消息数组的身份,text/id 等不可变字段成立;
  // blocks 等嵌套结构仍是活引用,消费方不得假设深冻结。
  const structuralMessagesRef = useRef(liveMessages)
  const structuralStreamingRef = useRef(streaming)
  const structuralRefreshedAtRef = useRef(0)
  if (
    !streaming
    || structuralStreamingRef.current !== streaming
    || !haveSameMessageIdentities(structuralMessagesRef.current, liveMessages)
    || Date.now() - structuralRefreshedAtRef.current >= 1000
  ) {
    structuralStreamingRef.current = streaming
    structuralMessagesRef.current = liveMessages
    structuralRefreshedAtRef.current = Date.now()
  }
  const structuralMessages = structuralMessagesRef.current
  const minimapItems = useMemo<MinimapItem[]>(
    () => collectConversationMinimapItems(structuralMessages).map((item) => ({
      id: item.id,
      title: summarizeMessageForPreview(item.title),
      preview: item.preview.trim(),
    })),
    [structuralMessages],
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
  const latestUserMessageKey = useMemo(() => getLatestUserMessageKey(liveMessages), [liveMessages])
  const setScrollButtonVisible = useCallback((visible: boolean) => {
    if (showScrollButtonRef.current === visible) return
    showScrollButtonRef.current = visible
    setShowScrollButton(visible)
  }, [])
  const suspendScrollCompensationForUserResize = useCallback(() => {
    shouldAutoScrollRef.current = false
  }, [])
  const clearProgrammaticScrollReleaseTimeout = useCallback(() => {
    if (programmaticScrollReleaseTimeoutRef.current === null) return
    window.clearTimeout(programmaticScrollReleaseTimeoutRef.current)
    programmaticScrollReleaseTimeoutRef.current = null
  }, [])
  const releaseProgrammaticScroll = useCallback(() => {
    programmaticScrollUntilRef.current = 0
    clearProgrammaticScrollReleaseTimeout()
  }, [clearProgrammaticScrollReleaseTimeout])
  // 用户通过消息级 minimap 主动跳转/拖拽 → 停止自动贴底并释放程序化滚动锁
  const handleMinimapNavigate = useCallback(() => {
    shouldAutoScrollRef.current = false
    releaseProgrammaticScroll()
  }, [releaseProgrammaticScroll])
  const markProgrammaticScroll = useCallback((behavior: ScrollBehavior) => {
    clearProgrammaticScrollReleaseTimeout()
    programmaticScrollUntilRef.current = getProgrammaticScrollHoldUntil({
      now: performance.now(),
      behavior,
    })
    if (behavior !== 'smooth') return
    programmaticScrollReleaseTimeoutRef.current = window.setTimeout(() => {
      programmaticScrollReleaseTimeoutRef.current = null
      programmaticScrollUntilRef.current = 0
    }, 1200)
  }, [clearProgrammaticScrollReleaseTimeout])
  const isProgrammaticScrollActive = useCallback(() => (
    programmaticScrollUntilRef.current === Number.POSITIVE_INFINITY
    || performance.now() < programmaticScrollUntilRef.current
  ), [])
  const suspendAutoScrollForUserNavigation = useCallback((deltaY?: number) => {
    const container = scrollContainerRef.current
    if (typeof deltaY === 'number' && deltaY >= 0 && container && isNearScrollBottom(container)) return
    releaseProgrammaticScroll()
    shouldAutoScrollRef.current = false
  }, [releaseProgrammaticScroll])
  const handleWheelNavigation = useCallback<WheelEventHandler<HTMLDivElement>>((event) => {
    suspendAutoScrollForUserNavigation(event.deltaY)
  }, [suspendAutoScrollForUserNavigation])
  const handleTouchNavigation = useCallback<TouchEventHandler<HTMLDivElement>>(() => {
    suspendAutoScrollForUserNavigation()
  }, [suspendAutoScrollForUserNavigation])
  const scrollBottomIntoView = useCallback((behavior: ScrollBehavior) => {
    const container = scrollContainerRef.current
    if (!container) return

    markProgrammaticScroll(behavior)
    const bottom = bottomRef.current
    if (bottom && typeof bottom.scrollIntoView === 'function') {
      bottom.scrollIntoView({ block: 'end', behavior })
    } else {
      container.scrollTop = container.scrollHeight
    }
    setScrollButtonVisible(false)
  }, [markProgrammaticScroll, setScrollButtonVisible])
  const scheduleBottomScroll = useCallback(() => {
    if (scheduledBottomScrollFrameRef.current !== 0) return
    scheduledBottomScrollFrameRef.current = requestAnimationFrame(() => {
      scheduledBottomScrollFrameRef.current = 0
      if (!shouldAutoScrollRef.current) return
      scrollBottomIntoView('auto')
    })
  }, [scrollBottomIntoView])
  const scrollMessagesToBottom = useCallback((animation: 'instant' | 'smooth' = 'smooth') => {
    const container = scrollContainerRef.current
    if (!container) return undefined

    shouldAutoScrollRef.current = true
    const behavior: ScrollBehavior = animation === 'smooth' ? 'smooth' : 'auto'

    const scrollOnce = () => {
      scrollBottomIntoView(behavior)
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
  }, [scrollBottomIntoView])

  useEffect(() => () => {
    if (scheduledBottomScrollFrameRef.current !== 0) {
      cancelAnimationFrame(scheduledBottomScrollFrameRef.current)
      scheduledBottomScrollFrameRef.current = 0
    }
    clearProgrammaticScrollReleaseTimeout()
  }, [clearProgrammaticScrollReleaseTimeout])

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

  useLayoutEffect(() => {
    activeThreadIdRef.current = threadId
    // 命中缓存立即填充，消除切会话空窗；未命中再由 IPC effect 异步加载
    setVisibleThreadMessages(threadMessagesCache.get(threadId) ?? [])
  }, [threadId])

  // #415:/clear 清空后立即清投影——sidecar clear 不广播事件,AgentInput 发
  // window 事件解耦(两处宿主 AgentView/RightPanelWorkspace 零接线)
  useEffect(() => {
    const onThreadCleared = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail
      if (detail?.threadId !== threadId) return
      setVisibleThreadMessages([])
    }
    window.addEventListener('lume:thread-cleared', onThreadCleared)
    return () => window.removeEventListener('lume:thread-cleared', onThreadCleared)
  }, [threadId])

  useEffect(() => {
    let cancelled = false
    const requestedThreadId = threadId
    getThreadMessages(requestedThreadId)
      .then((messages) => {
        if (!shouldApplyThreadMessagesResult({
          requestedThreadId,
          currentThreadId: activeThreadIdRef.current,
          cancelled,
        })) return
        setVisibleThreadMessages(messages)
        threadMessagesCache.set(requestedThreadId, messages)
      })
      .catch((err) => {
        if (!cancelled) console.error('[AgentMessages] 加载线程消息失败:', err)
      })
    return () => {
      cancelled = true
    }
  }, [threadId, userVersionRefreshKey])

  // 用户不在底部时有新消息到达 → 累加未读计数；滚到底部 / 点回到底部时清零
  useEffect(() => {
    if (newMessageIds.size > 0 && !shouldAutoScrollRef.current) {
      setUnreadCount((count) => count + newMessageIds.size)
    }
  }, [newMessageIds])

  useEffect(() => {
    previousMessageIdsRef.current = {
      threadId,
      ids: collectRuntimeMessageIds(liveMessages),
    }
  }, [liveMessages, threadId])

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const nearBottom = isNearScrollBottom(container)
    const programmatic = isProgrammaticScrollActive()
    if (nearBottom) setUnreadCount(0)
    if (programmatic && nearBottom) {
      releaseProgrammaticScroll()
    }
    shouldAutoScrollRef.current = shouldAutoScrollAfterUserScroll({
      nearBottom,
      programmatic,
    })
    if (programmatic && shouldAutoScrollRef.current) {
      if (nearBottom) setScrollButtonVisible(false)
      return
    }
    setScrollButtonVisible(!nearBottom && liveMessages.length > 0)
  }, [isProgrammaticScrollActive, liveMessages.length, releaseProgrammaticScroll, setScrollButtonVisible])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const content = contentRef.current
    if (!container || !content) return

    const resizeObserver = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) {
        scheduleBottomScroll()
      }
    })

    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [scheduleBottomScroll])

  useLayoutEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId
      stabilizeCacheRef.current.clear()
      reconcileCacheRef.current.clear()
      shouldAutoScrollRef.current = true
      latestUserMessageKeyRef.current = latestUserMessageKey
      return scrollMessagesToBottom('instant')
    }

    if (latestUserMessageKey && latestUserMessageKeyRef.current !== latestUserMessageKey) {
      latestUserMessageKeyRef.current = latestUserMessageKey
      return scrollMessagesToBottom('instant')
    }
    latestUserMessageKeyRef.current = latestUserMessageKey

    if (shouldAutoScrollRef.current && liveMessages.length > 0) {
      return scrollMessagesToBottom('instant')
    }
  }, [latestUserMessageKey, liveMessages.length, scrollMessagesToBottom, threadId])

  const latestTodo: TodoBlockData | null = useMemo(() => {
    // 直接从原始事件流取最新 todo 状态，避免依赖消息 block 的持久性
    // （跨 turn / projection fallback / stabilize 都可能让消息 block 不可达，
    // 导致思考或调用其他工具时面板消失）
    for (let i = runtimeEvents.length - 1; i >= 0; i -= 1) {
      const event = runtimeEvents[i]!
      if (event.type === 'todo.state_updated') {
        return { todos: event.todos, currentActiveForm: event.currentActiveForm }
      }
    }
    return null
  }, [runtimeEvents])

  const latestTaskProgress = useMemo(() => {
    for (let i = runtimeEvents.length - 1; i >= 0; i -= 1) {
      const event = runtimeEvents[i]!
      if (event.type === 'task.progress') return event
    }
    return null
  }, [runtimeEvents])

  // 任务事件变化时重置胶囊可见性（新事件先隐藏，胶囊挂载后经回调回报实际可见性）
  useEffect(() => {
    setTaskCapsuleVisible(false)
  }, [latestTaskProgress])

  const items: React.ReactNode[] = []
  let latestUserMessageIndex = -1
  for (let i = liveMessages.length - 1; i >= 0; i -= 1) {
    if (liveMessages[i]?.type === 'user') {
      latestUserMessageIndex = i
      break
    }
  }
  for (let i = 0; i < liveMessages.length; i++) {
    const msg = liveMessages[i]
    const activeStreamingMessage = streaming && i === liveMessages.length - 1
    items.push(
      <div
        key={`runtime-event-${msg.id}`}
        data-message-id={msg.id}
        data-message-role={msg.type}
        className="mx-auto w-full max-w-[920px] [content-visibility:auto] [contain-intrinsic-size:auto_160px]"
      >
        <RuntimeEventContentBlock
          message={msg}
          animate={activeStreamingMessage && newMessageIds.has(msg.id)}
          streaming={activeStreamingMessage}
          canEditUserMessage={i === latestUserMessageIndex}
          threadId={threadId}
          onOpenThreadFile={onOpenThreadFile}
          onOpenThreadImage={onOpenThreadImage}
          onOpenMemorySource={onOpenMemorySource}
          onUserResizeStart={suspendScrollCompensationForUserResize}
        />
      </div>,
    )
  }
  const hasRenderableMessages = liveMessages.length > 0

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={handleWheelNavigation}
        onTouchMove={handleTouchNavigation}
        className="agent-message-scrollbar h-full w-full overflow-y-auto"
      >
        <div
          ref={contentRef}
          className={cn(
            'min-h-full w-full px-3 py-5',
            !hasRenderableMessages ? 'flex items-center justify-center' : 'space-y-3'
          )}
        >
          {!hasRenderableMessages ? (
            <div className="text-center space-y-1">
              <p className="text-[var(--lume-text-secondary)] text-sm font-medium">Agent 已就绪</p>
              <p className="text-[var(--lume-text-muted)] text-xs">输入任务开始</p>
            </div>
          ) : (
            <>
              {items}
              <div ref={bottomRef} className="h-px w-full" aria-hidden />
            </>
          )}
        </div>
      </div>
      <AgentHistorySelectionLayer threadId={threadId} rootRef={contentRef} />
      {/* 胶囊可见时 todo 面板让位；胶囊终态自动消失后 todo 面板恢复，不因事件存在而永久压制 */}
      {latestTaskProgress && <TaskProgressCapsule event={latestTaskProgress} onVisibleChange={setTaskCapsuleVisible} />}
      <TodoPanel data={taskCapsuleVisible ? null : latestTodo} running={streaming} />
      <ScrollMinimap
        items={minimapItems}
        scrollContainerRef={scrollContainerRef}
        onNavigate={handleMinimapNavigate}
      />
      {showScrollButton && hasRenderableMessages && (
        <Button
                variant="ghost"
          type="button"
          onClick={() => { setUnreadCount(0); scrollMessagesToBottom('smooth') }}
          className="absolute bottom-4 right-14 z-20 inline-flex size-9 items-center justify-center rounded-full border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] text-[var(--lume-text-secondary)] shadow-[0_12px_30px_-24px_hsl(var(--lume-shadow-panel)/0.72)] transition-colors hover:border-[var(--lume-border-strong)] hover:text-[var(--lume-accent)]"
          aria-label="回到底部"
          title="回到底部"
        >
          <ArrowDown size={17} strokeWidth={2.2} />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--lume-accent)] px-1 text-[10px] font-medium leading-none text-white">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      )}
    </div>
  )
}
