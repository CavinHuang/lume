import { useRef, useEffect, useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useStickToBottom } from 'use-stick-to-bottom'
import { agentRuntimeEventsAtom, agentSubagentRunsAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getThreadMessages, getThreadRuntimeEvents, sidecarCall } from '@/lib/desktop-api'
import {
  AGENT_IPC_CHANNELS,
  type AgentListSubagentRunsResult,
  type AgentMessage,
  type AgentMessageAttachmentInput,
} from '@lume/shared'
import { cn } from '@/lib/utils'
import { hydrateRuntimeEvents } from '@/hooks/runtime-event-state'
import type { RuntimeMessageView } from './runtime-message-view'
import { projectRuntimeEventMessages } from './runtime-event-message-projection'
import { RuntimeEventContentBlock } from './RuntimeEventContentBlock'

interface AgentMessagesProps {
  threadId: string
  streaming: boolean
  onOpenThreadFile?: (path: string) => void
  onOpenMemorySource?: (path: string) => void
}

export function reconcileUserMessageVersions(
  messages: RuntimeMessageView[],
  visibleThreadMessages: AgentMessage[],
): RuntimeMessageView[] {
  const visibleUsers = visibleThreadMessages.filter((message) => message.role === 'user')
  if (visibleUsers.length === 0) return messages
  const usedVisibleIds = new Set<string>()

  return messages.map((message) => {
    if (message.type === 'user') {
      if (message.messageId) {
        const visible = visibleUsers.find((item) => item.id === message.messageId)
        return visible ? withPersistedUserAttachments(message, visible) : message
      }

      const visible = visibleUsers.find((item) => (
        !usedVisibleIds.has(item.id)
        && item.content === message.text
        && Math.abs(item.createdAt - Date.parse(message.createdAt)) < 10_000
      )) ?? visibleUsers.find((item) => !usedVisibleIds.has(item.id) && item.content === message.text)

      if (visible) {
        usedVisibleIds.add(visible.id)
        return withPersistedUserAttachments({
          ...message,
          id: visible.id,
          messageId: visible.id,
          versionGroupId: visible.versionGroupId,
          versionIndex: visible.versionIndex,
          versionCount: visible.versionCount,
        }, visible)
      }
      return message
    }

    return message
  })
}

function withPersistedUserAttachments(
  message: Extract<RuntimeMessageView, { type: 'user' }>,
  visible: AgentMessage,
): Extract<RuntimeMessageView, { type: 'user' }> {
  if (message.attachments?.length) return message
  const attachments = readPersistedMessageAttachments(visible.metadata)
  return attachments.length > 0 ? { ...message, attachments } : message
}

function readPersistedMessageAttachments(metadata: Record<string, unknown> | undefined): AgentMessageAttachmentInput[] {
  const raw = metadata?.messageAttachments
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentMessageAttachmentInput => (
    item !== null
    && typeof item === 'object'
    && typeof (item as AgentMessageAttachmentInput).id === 'string'
    && typeof (item as AgentMessageAttachmentInput).filename === 'string'
    && typeof (item as AgentMessageAttachmentInput).mediaType === 'string'
    && typeof (item as AgentMessageAttachmentInput).size === 'number'
    && typeof (item as AgentMessageAttachmentInput).threadPath === 'string'
  ))
}

export function AgentMessages({ threadId, streaming, onOpenThreadFile, onOpenMemorySource }: AgentMessagesProps) {
  const runtimeEvents = useAtomValue(agentRuntimeEventsAtom)[threadId]?.events ?? []
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const prevThreadIdRef = useRef(threadId)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const loadedThreadsRef = useRef<Set<string>>(new Set())
  const loadedRuntimeEventThreadsRef = useRef<Set<string>>(new Set())
  const [visibleThreadMessages, setVisibleThreadMessages] = useState<AgentMessage[]>([])
  const {
    contentRef: stickContentRef,
    scrollRef: stickScrollRef,
    scrollToBottom,
    isAtBottom,
  } = useStickToBottom({ resize: 'smooth', initial: 'instant' })
  const projectedMessages = useMemo(() => (
    runtimeEvents.length > 0
      ? projectRuntimeEventMessages(runtimeEvents)
      : []
  ), [runtimeEvents])
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
  const setContentRef = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element
    stickContentRef(element)
  }, [stickContentRef])
  const scrollMessagesToBottom = useCallback((animation: 'instant' | 'smooth' = 'smooth') => {
    void scrollToBottom({ animation, ignoreEscapes: true })
  }, [scrollToBottom])

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

  useLayoutEffect(() => {
    const viewport = containerRef.current?.closest('[data-slot="scroll-area-viewport"]')
    if (!(viewport instanceof HTMLDivElement)) return

    stickScrollRef(viewport)
    return () => {
      stickScrollRef(null)
    }
  }, [stickScrollRef])

  useLayoutEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId
      requestAnimationFrame(() => scrollMessagesToBottom('instant'))
      return
    }

    if (liveMessages.length === 1) {
      requestAnimationFrame(() => scrollMessagesToBottom('instant'))
    }
  }, [liveMessages.length, scrollMessagesToBottom, threadId])

  const items: React.ReactNode[] = []
  for (let i = 0; i < liveMessages.length; i++) {
    const msg = liveMessages[i]
    items.push(
      <RuntimeEventContentBlock
        key={`runtime-event-${msg.id}`}
        message={msg}
        animate={streaming && i === liveMessages.length - 1}
        threadId={threadId}
        onOpenThreadFile={onOpenThreadFile}
        onOpenMemorySource={onOpenMemorySource}
      />
    )
  }
  const hasRenderableMessages = liveMessages.length > 0

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div
        ref={setContentRef}
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
      {!isAtBottom && hasRenderableMessages && (
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
    </ScrollArea>
  )
}
