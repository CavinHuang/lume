import { useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import type { SDKMessage } from '@lume/shared'
import { SDKContentBlock } from './SDKContentBlock'
import { useSetAtom } from 'jotai'
import { agentSubagentRunsAtom, agentSDKMessagesAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useScrollPositionMemory } from '@/hooks/useScrollPositionMemory'
import { getThreadSDKMessages } from '@/lib/desktop-api'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentListSubagentRunsResult } from '@lume/shared'

interface AgentMessagesProps {
  threadId: string
  sdkMessages: SDKMessage[]
  streaming: boolean
}

function isNearBottom(el: HTMLElement | null): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100
}

export function AgentMessages({ threadId, sdkMessages, streaming }: AgentMessagesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevThreadIdRef = useRef(threadId)
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const loadedThreadsRef = useRef<Set<string>>(new Set())
  const wasNearBottomRef = useRef(true)

  const { save, restore } = useScrollPositionMemory()
  const getScrollElement = useCallback(() => {
    const viewport = containerRef.current?.closest('[data-slot="scroll-area-viewport"]')
    return viewport instanceof HTMLDivElement ? viewport : null
  }, [])

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
        setSDKMessages((prev) => ({ ...prev, [threadId]: [...list, ...(prev[threadId] ?? [])] }))
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

    const updateNearBottom = () => {
      wasNearBottomRef.current = isNearBottom(scrollElement)
    }

    updateNearBottom()
    scrollElement.addEventListener('scroll', updateNearBottom, { passive: true })
    return () => {
      scrollElement.removeEventListener('scroll', updateNearBottom)
    }
  }, [getScrollElement, sdkMessages.length, threadId])

  // 切换 thread 时保存/恢复滚动位置
  useEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      save(prevThreadIdRef.current, getScrollElement())
      prevThreadIdRef.current = threadId
      // 延迟恢复，等渲染完成
      requestAnimationFrame(() => {
        const scrollElement = getScrollElement()
        restore(threadId, scrollElement)
        wasNearBottomRef.current = isNearBottom(scrollElement)
      })
    }
  }, [getScrollElement, restore, save, threadId])

  // 流式输出时根据更新前的滚动状态决定是否继续跟随到底部
  useLayoutEffect(() => {
    if (streaming && wasNearBottomRef.current) {
      wasNearBottomRef.current = true
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [sdkMessages.length, streaming])

  if (sdkMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-1">
          <p className="text-foreground/50 text-sm font-medium">Agent 已就绪</p>
          <p className="text-foreground/30 text-xs">输入任务开始</p>
        </div>
      </div>
    )
  }

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
      <div ref={containerRef} className="space-y-2 px-4 py-4">
        {items}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
