import { useRef, useEffect, useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { ArrowDown } from 'lucide-react'
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
import { projectRenderableAgentMessages } from './agent-message-projection'

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

  const { save, restore, hasSavedPosition } = useScrollPositionMemory()
  const followSignal = getFollowSignal(sdkMessages)
  const renderMessages = useMemo(() => projectRenderableAgentMessages(sdkMessages), [sdkMessages])
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
    if (shouldFollowInitialBottomRef.current && scrollElement && sdkMessages.length > 0) {
      startInitialBottomFollow()
      return
    }
    const restored = restore(threadId, scrollElement)
    if (!restored && scrollElement && sdkMessages.length > 0) {
      startInitialBottomFollow()
      return
    }
    wasNearBottomRef.current = isNearBottom(scrollElement)
    setShowJumpToBottom(!wasNearBottomRef.current)
  }, [getScrollElement, restore, sdkMessages.length, startInitialBottomFollow, threadId])
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' })
    wasNearBottomRef.current = true
    setShowJumpToBottom(false)

    const scrollElement = getScrollElement()
    if (scrollElement) {
      requestAnimationFrame(() => save(threadId, scrollElement))
    }
  }, [getScrollElement, save, threadId])

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
        const hasMessages = sdkMessages.length > 0
        restoreCurrentThread()
        if (hasMessages && !shouldFollowInitialBottomRef.current) {
          pendingRestoreThreadIdRef.current = null
        }
      })
    }
  }, [cancelScheduledRestores, hasSavedPosition, restoreCurrentThread, sdkMessages.length, threadId])

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
      if (!shouldFollowInitialBottomRef.current) {
        pendingRestoreThreadIdRef.current = null
      }
    })
  }, [restoreCurrentThread, sdkMessages.length, threadId])

  useEffect(() => {
    if (!shouldFollowInitialBottomRef.current) return
    if (sdkMessages.length === 0) return
    startInitialBottomFollow()
    pendingRestoreThreadIdRef.current = null
  }, [sdkMessages.length, startInitialBottomFollow])

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
  for (let i = 0; i < renderMessages.length; i++) {
    const msg = renderMessages[i]
    items.push(
      <SDKContentBlock
        key={(msg as { uuid?: string }).uuid ?? `msg-${i}`}
        message={msg}
        index={i}
        animate={streaming && i === renderMessages.length - 1}
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
          'min-h-full w-full px-3 py-5',
          renderMessages.length === 0 ? 'flex items-center justify-center' : 'space-y-7'
        )}
      >
        {renderMessages.length === 0 ? (
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
      {showJumpToBottom && renderMessages.length > 0 && (
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
