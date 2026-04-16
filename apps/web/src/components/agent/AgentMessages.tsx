import { useRef, useEffect, useMemo, useCallback } from 'react'
import type { SDKMessage } from '@lume/shared'
import { SDKContentBlock } from './SDKContentBlock'
import { SubagentCard } from './SubagentCard'
import { useAtomValue, useSetAtom } from 'jotai'
import { agentSubagentRunsAtom, agentSDKMessagesAtom } from '@/atoms'
import { useScrollPositionMemory } from '@/hooks/useScrollPositionMemory'
import { getThreadSDKMessages } from '@/lib/desktop-api'
import { sidecarCall } from '@/lib/desktop-api'
import type { SubagentRunRecord, AgentListSubagentRunsResult } from '@lume/shared'

interface AgentMessagesProps {
  threadId: string
  sdkMessages: SDKMessage[]
  streaming: boolean
}

function buildSubagentToolMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord[]> {
  const map = new Map<string, SubagentRunRecord[]>()
  for (const run of runs) {
    if (run.parentToolUseId) {
      const list = map.get(run.parentToolUseId) ?? []
      list.push(run)
      map.set(run.parentToolUseId, list)
    }
  }
  return map
}

function getOrphanRuns(runs: SubagentRunRecord[], toolMap: Map<string, SubagentRunRecord[]>): SubagentRunRecord[] {
  const mapped = new Set<string>()
  for (const list of toolMap.values()) {
    for (const r of list) mapped.add(r.runId)
  }
  return runs.filter((r) => !mapped.has(r.runId))
}

export function AgentMessages({ threadId, sdkMessages, streaming }: AgentMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const subagentRuns = useAtomValue(agentSubagentRunsAtom)[threadId] ?? []
  const prevThreadIdRef = useRef(threadId)
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const loadedThreadsRef = useRef<Set<string>>(new Set())

  const { save, restore } = useScrollPositionMemory()

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

  const subagentToolMap = useMemo(() => buildSubagentToolMap(subagentRuns), [subagentRuns])
  const orphanRuns = useMemo(() => getOrphanRuns(subagentRuns, subagentToolMap), [subagentRuns, subagentToolMap])

  // 切换 thread 时保存/恢复滚动位置
  useEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      save(prevThreadIdRef.current, containerRef.current)
      prevThreadIdRef.current = threadId
      // 延迟恢复，等渲染完成
      requestAnimationFrame(() => restore(threadId, containerRef.current))
    }
  }, [threadId, save, restore])

  // 流式输出时自动滚动到底部
  const isNearBottom = useCallback(() => {
    const el = containerRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }, [])

  useEffect(() => {
    if (streaming && isNearBottom()) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [sdkMessages.length, subagentRuns.length, streaming, isNearBottom])

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
      />
    )

    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content as Array<{ type: string; id?: string }>) {
        if (block.type === 'tool_use' && block.id) {
          const runs = subagentToolMap.get(block.id)
          if (runs) {
            for (const run of runs) {
              items.push(<SubagentCard key={`sa-${run.runId}`} run={run} />)
            }
          }
        }
      }
    }
  }

  for (const run of orphanRuns) {
    items.push(<SubagentCard key={`sa-${run.runId}`} run={run} />)
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-2 scrollbar-none">
      {items}
      <div ref={bottomRef} />
    </div>
  )
}
