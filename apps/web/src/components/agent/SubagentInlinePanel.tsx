import { useState, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, CheckCircle, XCircle, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentSubagentMessagesAtom, agentSubagentRunsAtom } from '@/atoms'
import { SDKContentBlock } from './SDKContentBlock'
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime'
import type { SubagentRunStatus, SDKMessage } from '@lume/shared'

interface SubagentInlinePanelProps {
  runId: string
  threadId: string
  label?: string
  status?: SubagentRunStatus
  startedAt?: number
  depth?: number
}

const MAX_VISIBLE_TOOLS = 8

interface ToolPill {
  name: string
  done: boolean
}

function deriveCollapsedData(messages: SDKMessage[]) {
  const toolCalls: Array<{ name: string; id: string }> = []
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray((m as { message?: { content?: unknown[] } }).message?.content)) {
      const content = (m as { message: { content: unknown[] } }).message.content as Array<{ type: string; name?: string; id?: string }>
      for (const block of content) {
        if (block.type === 'tool_use' && block.name && block.id) {
          toolCalls.push({ name: block.name, id: block.id })
        }
      }
    }
  }

  const toolResultIds = new Set<string>()
  for (const m of messages) {
    if (m.type === 'tool_result') {
      const result = (m as { result?: { tool_use_id?: string } }).result
      if (result?.tool_use_id) toolResultIds.add(result.tool_use_id)
    }
  }

  const tools: ToolPill[] = toolCalls.map(tc => ({
    name: tc.name,
    done: toolResultIds.has(tc.id),
  }))

  let lastText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === 'assistant' && Array.isArray((m as { message?: { content?: unknown[] } }).message?.content)) {
      const content = (m as { message: { content: unknown[] } }).message.content as Array<{ type: string; text?: string }>
      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j].type === 'text' && content[j].text) {
          lastText = content[j].text ?? ''
          break
        }
      }
      if (lastText) break
    }
  }

  return { tools, lastText }
}

function countToolUses(messages: SDKMessage[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray((m as { message?: { content?: unknown[] } }).message?.content)) {
      const content = (m as { message: { content: unknown[] } }).message.content as Array<{ type: string }>
      for (const block of content) {
        if (block.type === 'tool_use') count++
      }
    }
  }
  return count
}

export function SubagentInlinePanel({ runId, threadId, label, status, startedAt, depth = 0 }: SubagentInlinePanelProps) {
  const [expanded, setExpanded] = useState(false)
  const subagentMessagesMap = useAtomValue(agentSubagentMessagesAtom)
  const subagentRunsMap = useAtomValue(agentSubagentRunsAtom)

  const runRecord = subagentRunsMap[threadId]?.find(r => r.runId === runId)
  const effectiveLabel = label ?? runRecord?.label ?? runRecord?.task ?? 'Subagent'
  const effectiveStatus = status ?? runRecord?.status
  const effectiveStartedAt = startedAt ?? runRecord?.startedAt ?? runRecord?.createdAt

  const messages = subagentMessagesMap[threadId]?.[runId] ?? []
  const isRunning = effectiveStatus === 'running' || effectiveStatus === 'accepted'
  const isError = effectiveStatus === 'errored' || effectiveStatus === 'timed_out' || effectiveStatus === 'aborted'
  const isDone = effectiveStatus === 'completed'
  const elapsed = useElapsedTime(effectiveStartedAt, isRunning)
  const toolCount = useMemo(() => countToolUses(messages), [messages])

  const indent = depth > 0

  return (
    <div
      className={cn(
        'rounded-xl border overflow-hidden',
        indent ? 'border-l-2 border-l-foreground/20' : '',
        isRunning ? 'border-blue-500/30 bg-blue-500/5' :
        isError ? 'border-destructive/30 bg-destructive/5' :
        'border-border/50 bg-muted/20',
      )}
    >
      <SubagentHeader
        label={effectiveLabel}
        isRunning={isRunning}
        isDone={isDone}
        isError={isError}
        elapsed={elapsed}
        toolCount={toolCount}
        expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      />
      {!expanded && messages.length > 0 && (
        <SubagentCollapsedPreview
          messages={messages}
          isRunning={isRunning}
        />
      )}
      {expanded && (
        <SubagentExpandedContent
          messages={messages}
          threadId={threadId}
          depth={depth}
          isRunning={isRunning}
        />
      )}
    </div>
  )
}

function SubagentHeader({
  label, isRunning, isDone, isError, elapsed, toolCount, expanded, onClick,
}: {
  label: string
  isRunning: boolean
  isDone: boolean
  isError: boolean
  elapsed: number
  toolCount: number
  expanded: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors text-left"
    >
      <ChevronDown size={12} className={cn('text-foreground/40 transition-transform flex-shrink-0', expanded && 'rotate-180')} />
      {isRunning && <Loader2 size={12} className="animate-spin text-blue-500 flex-shrink-0" />}
      {isDone && <CheckCircle size={12} className="text-green-500 flex-shrink-0" />}
      {isError && <XCircle size={12} className="text-destructive flex-shrink-0" />}
      <span className="flex-1 text-[13px] text-foreground/80 truncate font-medium">{label}</span>
      <span className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0',
        isRunning && 'bg-blue-500/15 text-blue-500',
        isDone && 'bg-green-500/15 text-green-500',
        isError && 'bg-destructive/15 text-destructive',
        !isRunning && !isDone && !isError && 'bg-muted text-muted-foreground',
      )}>
        {isRunning ? '运行中' : isDone ? '完成' : isError ? '错误' : '等待'}
      </span>
      <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">{formatElapsed(elapsed)}</span>
      {toolCount > 0 && (
        <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">🔧 {toolCount}</span>
      )}
    </button>
  )
}

function SubagentCollapsedPreview({ messages, isRunning }: { messages: SDKMessage[]; isRunning: boolean }) {
  const { tools, lastText } = useMemo(() => deriveCollapsedData(messages), [messages])
  const visibleTools = tools.slice(0, MAX_VISIBLE_TOOLS)
  const extraCount = tools.length - visibleTools.length

  if (!lastText && tools.length === 0) return null

  return (
    <div className="px-3 pb-2 space-y-1.5">
      {lastText && (
        <p className="text-[12px] text-foreground/60 leading-relaxed line-clamp-2 whitespace-pre-wrap">
          {lastText}
          {isRunning && <span className="inline-block w-[2px] h-[14px] bg-blue-500 animate-pulse ml-0.5 align-middle" />}
        </p>
      )}
      {visibleTools.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {visibleTools.map((t, i) => (
            <span
              key={`${t.name}-${i}`}
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded',
                t.done ? 'bg-green-500/15 text-green-600 dark:text-green-400' :
                isRunning ? 'bg-blue-500/15 text-blue-500' :
                'bg-muted text-muted-foreground',
              )}
            >
              {t.name} {t.done ? '✓' : isRunning ? '⏳' : ''}
            </span>
          ))}
          {extraCount > 0 && (
            <span className="text-[10px] text-muted-foreground/50">+{extraCount}</span>
          )}
        </div>
      )}
    </div>
  )
}

function SubagentExpandedContent({
  messages, depth, isRunning,
}: {
  messages: SDKMessage[]
  threadId: string
  depth: number
  isRunning: boolean
}) {
  if (messages.length === 0) {
    return (
      <div className="px-3 pb-2">
        <p className="text-[12px] text-muted-foreground/50">等待 subagent 输出...</p>
      </div>
    )
  }

  return (
    <div className={cn('border-t border-border/30 p-3 space-y-2', depth > 0 && depth < 3 && 'ml-3 border-l-2 border-l-foreground/15 pl-3')}>
      {messages.map((msg, i) => (
        <SDKContentBlock
          key={(msg as { uuid?: string }).uuid ?? `sub-${i}`}
          message={msg}
          index={i}
          animate={isRunning && i === messages.length - 1}
          allMessages={messages}
          isStreaming={isRunning}
        />
      ))}
    </div>
  )
}
