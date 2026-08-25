import { useMemo, useState, useRef, useLayoutEffect } from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, ChevronDown, Bot, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { agentRuntimeEventsFamily, agentSubagentRunsFamily } from '@/atoms'
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime'
import { getAgentRole, type SubagentRunStatus } from '@lume/shared'
import { resolveSubagentRoleDisplay } from './subagent-role-display'
import { selectSubagentRunEvents, summarizeSubagentRunActivity } from './subagent-run-projection'
import { applyRuntimeEventsIncremental, type ProjectionRef } from './runtime-event-message-projection'
import type { RuntimeMessageView } from './runtime-message-view'
import { RuntimeEventContentBlock } from './RuntimeEventContentBlock'
import { isNearScrollBottom } from './agent-message-state'
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
  const projectionRef = useRef<ProjectionRef | null>(null)
  const shouldAutoScrollRef = useRef(true)

  // 优先用 runId 查找，其次用 toolUseId 查找
  const runs = useAtomValue(agentSubagentRunsFamily(threadId)) ?? []
  const runRecord = runId
    ? runs.find(r => r.runId === runId)
    : toolUseId
      ? runs.find(r => r.parentToolUseId === toolUseId)
      : undefined
  const childThreadId = runRecord?.childThreadId
  const childEvents = useAtomValue(agentRuntimeEventsFamily(childThreadId ?? ''))?.events ?? []
  const runEvents = useMemo(
    () => runRecord ? selectSubagentRunEvents(childEvents, runRecord) : [],
    [childEvents, runRecord],
  )
  const runMessages = useMemo(() => {
    const projected = applyRuntimeEventsIncremental(runEvents, projectionRef.current)
    projectionRef.current = projected.ref
    return projected.messages
  }, [runEvents])
  const runActivity = useMemo(() => summarizeSubagentRunActivity(runEvents), [runEvents])

  const [stopping, setStopping] = useState(false)
  // 子线程事件流最后一条 usage.updated 的 billing.records 是全量快照，按当前 run 过滤求和
  const usageTotalTokens = useMemo(() => {
    if (!runId) return undefined
    for (let index = childEvents.length - 1; index >= 0; index -= 1) {
      const event = childEvents[index]
      if (event?.type !== 'usage.updated') continue
      let total = 0
      for (const record of event.billing?.records ?? []) {
        if (record.subagentRunId && record.subagentRunId !== runId) continue
        total += (record.inputTokens ?? 0) + (record.outputTokens ?? 0)
      }
      return total > 0 ? total : undefined
    }
    return undefined
  }, [childEvents, runId])
  const handleStopSubagent = async () => {
    if (!childThreadId || stopping) return
    onUserResizeStart?.()
    setStopping(true)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.STOP_THREAD, { threadId: childThreadId })
    } finally {
      setStopping(false)
    }
  }

  useLayoutEffect(() => {
    const container = expandedContentRef.current
    if (!expanded || !expandedContentMounted || !container || !shouldAutoScrollRef.current) return
    container.scrollTop = container.scrollHeight
  }, [expanded, expandedContentMounted, runMessages])

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
  const hasStatusError = effectiveStatus === 'errored' || effectiveStatus === 'timed_out' || effectiveStatus === 'aborted' || effectiveStatus === 'canceled'
  const hasOutcomeError = !!runRecord?.outcome?.error || !!runActivity.error
  const isError = hasStatusError || hasOutcomeError
  const errorMessage = runActivity.error ?? runRecord?.outcome?.error
  const isPending = !runRecord && !effectiveStatus
  const elapsed = useElapsedTime(effectiveStartedAt, isRunning || isPending)
  const collapsedOutput = runActivity.text || runRecord?.outcome?.output

  const indent = depth > 0
  const avatarSrc = resolveSubagentHeaderAvatarSrc(roleDisplay.runtimeId)
  const toggleExpanded = () => {
    onUserResizeStart?.()
    setExpanded((current) => {
      if (!current) shouldAutoScrollRef.current = true
      return !current
    })
  }
  const handleConversationScroll = () => {
    const container = expandedContentRef.current
    if (container) shouldAutoScrollRef.current = isNearScrollBottom(container)
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
        <SubagentRunningPreview
          output={collapsedOutput}
          latestToolName={runActivity.toolName}
          onStop={handleStopSubagent}
          stopping={stopping}
        />
      )}
      {!expanded && !isPending && isDone && (
        <SubagentCompletedPreview output={collapsedOutput} />
      )}
      {!expanded && !isPending && isError && (
        <SubagentErrorPreview error={errorMessage} />
      )}
      {expandedContentMounted && (
        <AnimatedCollapsiblePanel open={expanded}>
          <div
            ref={expandedContentRef}
            onScroll={handleConversationScroll}
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
              messages={runMessages}
              childThreadId={childThreadId}
              usageTotalTokens={usageTotalTokens}
              onStop={handleStopSubagent}
              stopping={stopping}
              onUserResizeStart={onUserResizeStart}
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
        'w-full flex items-center justify-start gap-2 px-3 py-2 hover:bg-muted/30 transition-colors text-left',
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
        !isRunning && !isPending && !isDone && !isError && 'bg-muted text-muted-foreground',
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

function SubagentRunningPreview({ output, latestToolName, onStop, stopping }: {
  output?: string
  latestToolName?: string
  onStop?: () => void
  stopping?: boolean
}) {
  return (
    <div className="px-3 pb-2 flex items-center gap-2">
      <p className="text-[12px] text-foreground/60 flex items-center gap-1.5 flex-1 min-w-0">
        <Loader2 size={10} className="animate-spin text-blue-500 flex-shrink-0" />
        <span className="line-clamp-2">{output ? getSubagentCollapsedPreviewText(output) : latestToolName ? `正在使用 ${latestToolName}...` : 'Subagent 正在执行...'}</span>
      </p>
      {onStop && <SubagentStopButton onStop={onStop} stopping={stopping} />}
    </div>
  )
}

function SubagentStopButton({ onStop, stopping }: { onStop: () => void; stopping?: boolean }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onStop()
      }}
      disabled={stopping}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
    >
      <Square size={8} strokeWidth={3} />
      {stopping ? '停止中...' : '停止'}
    </button>
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
  depth, isRunning, agentType, roleBadges, task, prompt, error, messages, childThreadId, usageTotalTokens, onStop, stopping, onUserResizeStart,
}: {
  depth: number
  isRunning: boolean
  agentType: string
  roleBadges: string[]
  task?: string
  prompt?: string
  error?: string
  messages: RuntimeMessageView[]
  childThreadId?: string
  usageTotalTokens?: number
  onStop?: () => void
  stopping?: boolean
  onUserResizeStart?: () => void
}) {
  let latestUserMessageIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === 'user') {
      latestUserMessageIndex = index
      break
    }
  }

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
          {usageTotalTokens !== undefined && (
            <p className="text-caption text-foreground/45">Token: {formatTokenCount(usageTotalTokens)}</p>
          )}
          {prompt && prompt !== task && (
            <p className="text-[11px] text-foreground/40 leading-relaxed line-clamp-3">
              <span className="text-foreground/30">提示: </span>{prompt}
            </p>
          )}
        </div>
      )}
      {/* 消息流 */}
      <div className="space-y-5 overflow-hidden p-3">
        {messages.length === 0 && !error && (
          <p className="text-[12px] text-muted-foreground/50">等待 subagent 结果...</p>
        )}
        {childThreadId && messages.map((message, index) => (
          <RuntimeEventContentBlock
            key={message.id}
            message={message}
            threadId={childThreadId}
            streaming={isRunning && index === messages.length - 1}
            canEditUserMessage={index === latestUserMessageIndex}
            showAssistantAvatar={false}
            onUserResizeStart={onUserResizeStart}
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
            {onStop && <SubagentStopButton onStop={onStop} stopping={stopping} />}
          </div>
        )}
      </div>
    </div>
  )
}

function getSubagentCollapsedPreviewText(output: string): string {
  const withoutCodeBlocks = output.replace(/```[\s\S]*?```/g, ' ')
  const withoutLinks = withoutCodeBlocks.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  const plain = withoutLinks
    .replace(/[#>*_`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain || '结果已完成'
}

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}
