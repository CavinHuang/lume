import { memo, useState, useRef, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, ChevronDown, Bot, Copy, Check, AlertTriangle } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { cn } from '@/lib/utils'
import { agentSubagentRunsFamily } from '@/atoms'
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime'
import { getAgentRole, type SubagentRunStatus } from '@lume/shared'
import { resolveSubagentRoleDisplay } from './subagent-role-display'
import { AnimatedCollapsiblePanel, useDeferredUnmount } from './AnimatedCollapsiblePanel'
import { AGENT_ROLE_ASSETS } from '@/components/settings/agents-settings-state'

import { Button } from '@/components/ui/button'
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
  onUserResizeStart?: () => void
}

export function SubagentInlinePanel({ runId, threadId, toolUseId, description, agentType, prompt, label, status, startedAt, depth = 0, onUserResizeStart }: SubagentInlinePanelProps) {
  const [expanded, setExpanded] = useState(false)
  const expandedContentMounted = useDeferredUnmount(expanded)
  const expandedContentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!expanded || !expandedContentMounted) return
    if (expandedContentRef.current) {
      expandedContentRef.current.scrollTop = 0
    }
  }, [expanded, expandedContentMounted])

  // 优先用 runId 查找，其次用 toolUseId 查找
  const runs = useAtomValue(agentSubagentRunsFamily(threadId)) ?? []
  const runRecord = runId
    ? runs.find(r => r.runId === runId)
    : toolUseId
      ? runs.find(r => r.parentToolUseId === toolUseId)
      : undefined

  const requestedAgentId = (runRecord as { requestedAgentId?: string } | undefined)?.requestedAgentId
  const resolvedAgentId = (runRecord as { resolvedAgentId?: string } | undefined)?.resolvedAgentId
  const effectiveAgentType = agentType ?? requestedAgentId ?? 'general-purpose'
  const fallbackLabel = label ?? runRecord?.label ?? description ?? runRecord?.task ?? 'Subagent'
  const roleDisplay = resolveSubagentRoleDisplay({
    agentType: effectiveAgentType,
    requestedAgentId,
    resolvedAgentId,
    label: fallbackLabel,
  })
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
  const avatarSrc = resolveSubagentHeaderAvatarSrc(roleDisplay.runtimeId)
  const toggleExpanded = () => {
    onUserResizeStart?.()
    setExpanded(v => !v)
  }

  return (
    <div
      className={cn(
        'rounded-xl border',
        'overflow-hidden',
        indent ? 'border-l-2 border-l-foreground/20' : '',
        isPending ? 'border-blue-500/20 bg-blue-500/5' :
        isRunning ? 'border-blue-500/30 bg-blue-500/5' :
        isError ? 'border-destructive/30 bg-destructive/5' :
        'border-border/50 bg-black/[0.03] dark:bg-white/[0.04]',
      )}
    >
      <SubagentHeader
        label={roleDisplay.primaryLabel}
        agentType={roleDisplay.runtimeId}
        isRunning={isRunning}
        isPending={isPending}
        isDone={isDone}
        isError={isError}
        elapsed={elapsed}
        expanded={expanded}
        avatarSrc={avatarSrc}
        onClick={toggleExpanded}
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
      {expandedContentMounted && (
        <AnimatedCollapsiblePanel open={expanded}>
          <div
            ref={expandedContentRef}
            className="max-h-[min(70vh,720px)] overflow-y-auto overscroll-contain border-t border-border/30"
          >
            <SubagentExpandedContent
              depth={depth}
              isRunning={isRunning}
              agentType={roleDisplay.runtimeId}
              roleBadges={roleDisplay.badges}
              task={description ?? runRecord?.task ?? prompt}
              prompt={prompt}
              error={isError ? errorMessage : undefined}
              output={finalOutput}
            />
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
}

export function SubagentHeader({
  label, agentType, isRunning, isPending, isDone, isError, elapsed, expanded, avatarSrc, onClick,
}: {
  label: string
  agentType: string
  isRunning: boolean
  isPending: boolean
  isDone: boolean
  isError: boolean
  elapsed: number
  expanded: boolean
  avatarSrc?: string
  onClick: () => void
}) {
  return (
    <Button
                variant="ghost"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors text-left',
      )}
    >
      <ChevronDown size={12} className={cn('text-foreground/40 transition-transform flex-shrink-0', expanded && 'rotate-180')} />
      {avatarSrc ? (
        <img
          data-subagent-avatar="true"
          src={avatarSrc}
          alt=""
          className="size-6 flex-shrink-0 rounded-full object-cover ring-1 ring-border/60"
        />
      ) : (
        <Bot data-subagent-avatar-fallback="true" size={12} className="text-foreground/40 flex-shrink-0" />
      )}
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
    </Button>
  )
}

export function resolveSubagentHeaderAvatarSrc(agentType: string): string | undefined {
  const role = getAgentRole(agentType)
  return role ? AGENT_ROLE_ASSETS.roles[role.id] : undefined
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
    <div className="max-h-12 overflow-hidden px-3 pb-2">
      <p className="line-clamp-2 text-[12px] leading-relaxed text-foreground/55">
        {getSubagentCollapsedPreviewText(output)}
      </p>
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
  depth, isRunning, agentType, roleBadges, task, prompt, error, output,
}: {
  depth: number
  isRunning: boolean
  agentType: string
  roleBadges: string[]
  task?: string
  prompt?: string
  error?: string
  output?: string
}) {
  return (
    <div className={cn(depth > 0 && depth < 3 && 'ml-3 border-l-2 border-l-foreground/15')}>
      {/* Subagent 详情区域 */}
      {(task || agentType || prompt) && (
        <div className="px-3 py-2 bg-muted/10 border-b border-border/20 space-y-1">
          <div className="flex items-center gap-2">
            <Bot size={11} className="text-foreground/40" />
            <span className="text-[11px] font-medium text-foreground/60">Subagent: {agentType}</span>
          </div>
          {roleBadges.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {roleBadges.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full border border-border/40 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/45"
                >
                  {badge}
                </span>
              ))}
            </div>
          )}
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
          <SubagentResultCard output={output} />
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

export function SubagentResultCard({ output }: { output: string }) {
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const truncated = isSubagentOutputTruncated(output)

  useEffect(() => () => {
    if (copyResetRef.current !== null) {
      clearTimeout(copyResetRef.current)
      copyResetRef.current = null
    }
  }, [])

  const copyOutput = async () => {
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard)
    if (!writeText) return

    try {
      await writeText(output)
      setCopied(true)
      if (copyResetRef.current !== null) {
        clearTimeout(copyResetRef.current)
      }
      copyResetRef.current = setTimeout(() => {
        setCopied(false)
        copyResetRef.current = null
      }, 2000)
    } catch (error) {
      console.error('[SubagentInlinePanel] 复制 subagent 结果失败:', error)
    }
  }

  return (
    <article className="overflow-hidden rounded-lg border border-border/40 bg-background/80">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/35 bg-muted/20 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground/60">
          <Check size={12} className="shrink-0 text-green-500" />
          <span className="truncate">结果已完成</span>
        </div>
        <Button
                variant="ghost"
          type="button"
          onClick={() => void copyOutput()}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-foreground/50 transition-colors hover:bg-background/70 hover:text-foreground"
          title={copied ? '已复制' : '复制 subagent 结果'}
          aria-label={copied ? '已复制 subagent 结果' : '复制 subagent 结果'}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制结果'}</span>
        </Button>
      </div>
      {truncated && (
        <div
          data-subagent-output-truncated="true"
          className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-5 text-amber-700 dark:text-amber-200"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>结果可能被截断，完整内容可能需要让 subagent 写入文件或重新输出。</span>
        </div>
      )}
      <div className="px-3 py-2">
        <SubagentMarkdown output={output} />
      </div>
    </article>
  )
}

export function isSubagentOutputTruncated(output: string): boolean {
  return /\.\.\.\(truncated(?:\s+by [^)]+)?\)(?:\.\.\.)?/i.test(output)
}

function useIsDark(): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof document === 'undefined') return () => {}
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => observer.disconnect()
    },
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    () => false,
  )
}

export const SubagentMarkdown = memo(function SubagentMarkdown({ output, compact = false }: { output: string; compact?: boolean }) {
  const isDark = useIsDark()

  return (
    <div className="min-w-0 w-full overflow-hidden">
      <XMarkdown
        className={cn(
          'agent-message-markdown x-markdown text-[12px] leading-relaxed',
          compact && '[&_ol]:my-1 [&_p]:mb-1 [&_ul]:my-1',
        )}
        rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
      >
        {output}
      </XMarkdown>
    </div>
  )
})

function getSubagentCollapsedPreviewText(output: string): string {
  const withoutCodeBlocks = output.replace(/```[\s\S]*?```/g, ' ')
  const withoutLinks = withoutCodeBlocks.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  const plain = withoutLinks
    .replace(/[#>*_`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain || '结果已完成'
}
