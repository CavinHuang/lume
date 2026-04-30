import { useState, useRef, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, ChevronDown, Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentSubagentRunsAtom } from '@/atoms'
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime'
import type { SubagentRunStatus } from '@lume/shared'

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

export function SubagentInlinePanel({ runId, threadId, toolUseId, description, agentType, prompt, label, status, startedAt, depth = 0 }: SubagentInlinePanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [isStuck, setIsStuck] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const subagentRunsMap = useAtomValue(agentSubagentRunsAtom)

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

  const effectiveAgentType = agentType ?? (runRecord as { requestedAgentId?: string } | undefined)?.requestedAgentId ?? 'general-purpose'
  const effectiveLabel = label ?? runRecord?.label ?? description ?? runRecord?.task ?? 'Subagent'
  const effectiveStatus = status ?? runRecord?.status
  const effectiveStartedAt = startedAt ?? runRecord?.startedAt ?? runRecord?.createdAt

  const isRunning = effectiveStatus === 'running' || effectiveStatus === 'accepted'
  const isDone = effectiveStatus === 'completed'
  const hasStatusError = effectiveStatus === 'errored' || effectiveStatus === 'timed_out' || effectiveStatus === 'aborted'
  const hasOutcomeError = !!runRecord?.outcome?.error
  const isError = hasStatusError || hasOutcomeError
  const errorMessage = runRecord?.outcome?.error
  const isPending = !runRecord && !effectiveStatus
  const elapsed = useElapsedTime(effectiveStartedAt, isRunning || isPending)
  const finalOutput = isDone ? runRecord?.outcome?.output : undefined

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
        'border-border/50 bg-black/[0.03] dark:bg-white/[0.04]',
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
        <SubagentRunningPreview />
      )}
      {!expanded && !isPending && isDone && (
        <SubagentCompletedPreview output={finalOutput} />
      )}
      {!expanded && !isPending && isError && (
        <SubagentErrorPreview error={errorMessage} />
      )}
      {expanded && (
        <SubagentExpandedContent
          depth={depth}
          isRunning={isRunning}
          agentType={effectiveAgentType}
          task={description ?? runRecord?.task ?? prompt}
          prompt={prompt}
          error={isError ? errorMessage : undefined}
          output={finalOutput}
        />
      )}
    </div>
  )
}

function SubagentHeader({
  label, agentType, isRunning, isPending, isDone, isError, elapsed, expanded, isStuck, onClick,
}: {
  label: string
  agentType: string
  isRunning: boolean
  isPending: boolean
  isDone: boolean
  isError: boolean
  elapsed: number
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
    </button>
  )
}

function SubagentRunningPreview() {
  return (
    <div className="px-3 pb-2">
      <p className="text-[12px] text-foreground/60 flex items-center gap-1.5">
        <Loader2 size={10} className="animate-spin text-blue-500 flex-shrink-0" />
        <span>Subagent 正在执行...</span>
      </p>
    </div>
  )
}

function SubagentCompletedPreview({ output }: { output?: string }) {
  if (!output) return null

  return (
    <div className="px-3 pb-2">
      <p className="text-[12px] text-foreground/60 leading-relaxed line-clamp-2 whitespace-pre-wrap">{output}</p>
    </div>
  )
}

function SubagentErrorPreview({ error }: { error?: string }) {
  if (!error) return null
  return (
    <div className="px-3 pb-2">
      <p className="text-[12px] text-destructive leading-relaxed line-clamp-3 whitespace-pre-wrap">
        {error || '执行失败'}
      </p>
    </div>
  )
}

function SubagentExpandedContent({
  depth, isRunning, agentType, task, prompt, error, output,
}: {
  depth: number
  isRunning: boolean
  agentType: string
  task?: string
  prompt?: string
  error?: string
  output?: string
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
      <div className="p-3 space-y-2 overflow-hidden">
        {!output && !error && (
          <p className="text-[12px] text-muted-foreground/50">等待 subagent 结果...</p>
        )}
        {output && (
          <div className="rounded-lg bg-muted/20 border border-border/20 px-3 py-2">
            <p className="text-[12px] text-foreground/70 whitespace-pre-wrap leading-relaxed">{output}</p>
          </div>
        )}
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
