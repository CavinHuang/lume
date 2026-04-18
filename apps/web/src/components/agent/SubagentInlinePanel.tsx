import { useState, useMemo, useRef, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, ChevronDown, Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentSubagentMessagesAtom, agentSubagentRunsAtom, agentSubagentToolProgressAtom } from '@/atoms'
import { SDKContentBlock } from './SDKContentBlock'
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime'
import type { SubagentRunStatus, SDKMessage } from '@lume/shared'

interface SubagentInlinePanelProps {
  runId?: string
  threadId: string
  toolUseId?: string
  description?: string
  agentType?: string
  prompt?: string
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

function deriveErrorFromMessages(messages: SDKMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === 'tool_result') {
      const r = m as { is_error?: boolean; result?: { output?: string } }
      if (r.is_error && r.result?.output) return r.result.output
    }
  }
  return undefined
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

function extractFinalOutput(messages: SDKMessage[], runRecord: { outcome?: { output?: string } } | undefined): string | undefined {
  if (runRecord?.outcome?.output) return runRecord.outcome.output
  // 从消息流中提取最后一条 assistant 的文本
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === 'assistant' && Array.isArray((m as { message?: { content?: unknown[] } }).message?.content)) {
      const content = (m as { message: { content: unknown[] } }).message.content as Array<{ type: string; text?: string }>
      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j].type === 'text' && content[j].text?.trim()) {
          return content[j].text!.trim()
        }
      }
    }
  }
  return undefined
}

export function SubagentInlinePanel({ runId, threadId, toolUseId, description, agentType, prompt, label, status, startedAt, depth = 0 }: SubagentInlinePanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [isStuck, setIsStuck] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const subagentMessagesMap = useAtomValue(agentSubagentMessagesAtom)
  const subagentRunsMap = useAtomValue(agentSubagentRunsAtom)
  const subagentToolProgressMap = useAtomValue(agentSubagentToolProgressAtom)

  // 检测 header 是否处于 sticky stuck 状态
  useEffect(() => {
    if (!expanded || !sentinelRef.current) { setIsStuck(false); return }
    const el = sentinelRef.current
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      { threshold: 0, rootMargin: '0px 0px 999999px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded])

  // 优先用 runId 查找，其次用 toolUseId 查找
  const runs = subagentRunsMap[threadId] ?? []
  const runRecord = runId
    ? runs.find(r => r.runId === runId)
    : toolUseId
      ? runs.find(r => r.parentToolUseId === toolUseId)
      : undefined

  const effectiveRunId = runId ?? runRecord?.runId
  const effectiveAgentType = agentType ?? (runRecord as { requestedAgentId?: string } | undefined)?.requestedAgentId ?? 'general-purpose'
  const effectiveLabel = label ?? runRecord?.label ?? description ?? runRecord?.task ?? 'Subagent'
  const effectiveStatus = status ?? runRecord?.status
  const effectiveStartedAt = startedAt ?? runRecord?.startedAt ?? runRecord?.createdAt

  const messages = effectiveRunId ? (subagentMessagesMap[threadId]?.[effectiveRunId] ?? []) : []
  const isRunning = effectiveStatus === 'running' || effectiveStatus === 'accepted'
  const isDone = effectiveStatus === 'completed'
  const hasStatusError = effectiveStatus === 'errored' || effectiveStatus === 'timed_out' || effectiveStatus === 'aborted'
  const hasOutcomeError = !!runRecord?.outcome?.error
  const hasMessageError = messages.some(m => m.type === 'tool_result' && (m as { is_error?: boolean }).is_error)
  const isError = hasStatusError || hasOutcomeError || hasMessageError
  const errorMessage = runRecord?.outcome?.error ?? deriveErrorFromMessages(messages)
  const isPending = !runRecord && !effectiveStatus
  const elapsed = useElapsedTime(effectiveStartedAt, isRunning || isPending)
  const toolCount = useMemo(() => countToolUses(messages), [messages])

  // 当前正在执行的工具
  const currentTool = effectiveRunId ? subagentToolProgressMap[threadId]?.[effectiveRunId] : undefined
  const finalOutput = isDone ? extractFinalOutput(messages, runRecord) : undefined

  const indent = depth > 0

  return (
    <div
      className={cn(
        'rounded-xl border',
        expanded ? 'overflow-visible' : 'overflow-hidden',
        indent ? 'border-l-2 border-l-foreground/20' : '',
        isPending ? 'border-blue-500/20 bg-blue-500/5' :
        isRunning ? 'border-blue-500/30 bg-blue-500/5' :
        isError ? 'border-destructive/30 bg-destructive/5' :
        'border-border/50 bg-muted/20',
      )}
    >
      {expanded && <div ref={sentinelRef} className="h-0" />}
      <SubagentHeader
        label={effectiveLabel}
        agentType={effectiveAgentType}
        isRunning={isRunning}
        isPending={isPending}
        isDone={isDone}
        isError={isError}
        elapsed={elapsed}
        toolCount={toolCount}
        currentTool={currentTool}
        expanded={expanded}
        isStuck={isStuck}
        onClick={() => setExpanded(v => !v)}
      />
      {isPending && (
        <div className="px-3 pb-2">
          <p className="text-[12px] text-muted-foreground/50 flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin text-blue-500" />
            等待 subagent 启动...
          </p>
        </div>
      )}
      {!expanded && !isPending && isRunning && (
        <SubagentRunningPreview
          messages={messages}
          currentTool={currentTool}
        />
      )}
      {!expanded && !isPending && isDone && (
        <SubagentCompletedPreview
          output={finalOutput}
          messages={messages}
        />
      )}
      {!expanded && !isPending && isError && (
        <SubagentErrorPreview error={errorMessage} />
      )}
      {expanded && (
        <SubagentExpandedContent
          messages={messages}
          depth={depth}
          isRunning={isRunning}
          agentType={effectiveAgentType}
          task={description ?? runRecord?.task ?? prompt}
          prompt={prompt}
          error={isError ? errorMessage : undefined}
        />
      )}
    </div>
  )
}

function SubagentHeader({
  label, agentType, isRunning, isPending, isDone, isError, elapsed, toolCount, currentTool, expanded, isStuck, onClick,
}: {
  label: string
  agentType: string
  isRunning: boolean
  isPending: boolean
  isDone: boolean
  isError: boolean
  elapsed: number
  toolCount: number
  currentTool?: { toolName: string; elapsedSeconds: number }
  expanded: boolean
  isStuck: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors text-left sticky top-0 z-10',
        isStuck && 'bg-muted border-b border-border/30 shadow-sm',
      )}
    >
      <ChevronDown size={12} className={cn('text-foreground/40 transition-transform flex-shrink-0', expanded && 'rotate-180')} />
      <Bot size={12} className="text-foreground/40 flex-shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="text-[13px] text-foreground/80 truncate font-medium">{label}</span>
        <span className="text-[10px] text-foreground/40 ml-1.5">{agentType}</span>
      </span>
      {isRunning && currentTool && (
        <span className="text-[10px] text-blue-500/80 truncate max-w-[120px] flex-shrink-0">
          {currentTool.toolName} {currentTool.elapsedSeconds > 0 ? `${currentTool.elapsedSeconds.toFixed(1)}s` : ''}
        </span>
      )}
      <span className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0',
        (isRunning || isPending) && 'bg-blue-500/15 text-blue-500',
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

function SubagentRunningPreview({ messages, currentTool }: { messages: SDKMessage[]; currentTool?: { toolName: string; elapsedSeconds: number } }) {
  const { tools } = useMemo(() => deriveCollapsedData(messages), [messages])
  const visibleTools = tools.slice(0, MAX_VISIBLE_TOOLS)
  const extraCount = tools.length - visibleTools.length

  return (
    <div className="px-3 pb-2 space-y-1.5">
      {currentTool && (
        <p className="text-[12px] text-foreground/60 flex items-center gap-1.5">
          <Loader2 size={10} className="animate-spin text-blue-500 flex-shrink-0" />
          <span>使用 {currentTool.toolName}</span>
          {currentTool.elapsedSeconds > 0 && <span className="text-muted-foreground/50">{currentTool.elapsedSeconds.toFixed(1)}s</span>}
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
                'bg-blue-500/15 text-blue-500',
              )}
            >
              {t.name} {t.done ? '✓' : '...'}
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

function SubagentCompletedPreview({ output, messages }: { output?: string; messages: SDKMessage[] }) {
  const { tools } = useMemo(() => deriveCollapsedData(messages), [messages])

  if (!output && tools.length === 0) return null

  return (
    <div className="px-3 pb-2 space-y-1.5">
      {output && (
        <p className="text-[12px] text-foreground/60 leading-relaxed line-clamp-2 whitespace-pre-wrap">{output}</p>
      )}
      {tools.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {tools.slice(0, MAX_VISIBLE_TOOLS).map((t, i) => (
            <span key={`${t.name}-${i}`} className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400">
              {t.name} ✓
            </span>
          ))}
          {tools.length > MAX_VISIBLE_TOOLS && (
            <span className="text-[10px] text-muted-foreground/50">+{tools.length - MAX_VISIBLE_TOOLS}</span>
          )}
        </div>
      )}
    </div>
  )
}

function SubagentErrorPreview({ error }: { error?: string }) {
  if (!error) return null
  return (
    <div className="px-3 pb-2">
      <p className="text-[12px] text-destructive leading-relaxed line-clamp-2 whitespace-pre-wrap">{error}</p>
    </div>
  )
}

function SubagentExpandedContent({
  messages, depth, isRunning, agentType, task, prompt, error,
}: {
  messages: SDKMessage[]
  depth: number
  isRunning: boolean
  agentType: string
  task?: string
  prompt?: string
  error?: string
}) {
  return (
    <div className={cn('border-t border-border/30', depth > 0 && depth < 3 && 'ml-3 border-l-2 border-l-foreground/15')}>
      {/* Subagent 详情区域 */}
      {(task || agentType || prompt) && (
        <div className="px-3 py-2 bg-muted/10 border-b border-border/20 space-y-1">
          <div className="flex items-center gap-2">
            <Bot size={11} className="text-foreground/40" />
            <span className="text-[11px] font-medium text-foreground/60">Subagent: {agentType}</span>
          </div>
          {task && (
            <p className="text-[11px] text-foreground/50 leading-relaxed">
              <span className="text-foreground/30">任务: </span>{task}
            </p>
          )}
          {prompt && prompt !== task && (
            <p className="text-[11px] text-foreground/40 leading-relaxed line-clamp-3">
              <span className="text-foreground/30">提示: </span>{prompt}
            </p>
          )}
        </div>
      )}
      {/* 消息流 */}
      <div className="p-3 space-y-2">
        {messages.length === 0 && !error && (
          <p className="text-[12px] text-muted-foreground/50">等待 subagent 输出...</p>
        )}
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
        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
            <p className="text-[12px] text-destructive whitespace-pre-wrap leading-relaxed">{error}</p>
          </div>
        )}
        {isRunning && (
          <div className="flex items-center gap-1.5 pt-1">
            <Loader2 size={10} className="animate-spin text-blue-500" />
            <span className="text-[11px] text-blue-500/80">运行中...</span>
          </div>
        )}
      </div>
    </div>
  )
}
