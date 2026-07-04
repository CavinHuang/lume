import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { agentRuntimeEventsFamily, agentThreadsAtom, agentRuntimeStatusFamily, agentStreamingStatesFamily } from '@/atoms'
import { ThreadMoreActions } from './ThreadMoreActions'
import type { AgentRuntimePhase } from '@lume/shared'

interface AgentHeaderProps {
  threadId: string
  readOnly?: boolean
}

const PHASE_STYLE: Record<AgentRuntimePhase, { label: string; dot: string; text: string }> = {
  idle: { label: '空闲', dot: 'bg-[var(--lume-text-muted)]', text: 'text-[var(--lume-text-muted)]' },
  streaming: { label: '运行中', dot: 'bg-[var(--lume-accent)] animate-pulse', text: 'text-[var(--lume-accent)]' },
  awaiting_permission: { label: '等待授权', dot: 'bg-[var(--lume-warning)]', text: 'text-[var(--lume-warning)]' },
  awaiting_user_answer: { label: '等待回答', dot: 'bg-[var(--lume-warning)]', text: 'text-[var(--lume-warning)]' },
  compacting: { label: '压缩中', dot: 'bg-[var(--lume-accent-2)] animate-pulse', text: 'text-[var(--lume-accent-2)]' },
  completed: { label: '已完成', dot: 'bg-[var(--lume-success)]', text: 'text-[var(--lume-success)]' },
  errored: { label: '出错', dot: 'bg-[var(--lume-danger)]', text: 'text-[var(--lume-danger)]' },
}

export function AgentHeader({ threadId, readOnly }: AgentHeaderProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const thread = threads.find((t) => t.id === threadId)
  const runtimeStatus = useAtomValue(agentRuntimeStatusFamily(threadId))
  const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
  // 回退：RUNTIME_STATUS_CHANGED 通道不稳时，用 RUNTIME_EVENT 流的 streamingState 保证徽章可见
  const isStreamingFallback = useAtomValue(agentStreamingStatesFamily(threadId)) === 'streaming'

  const runtimePhase = runtimeStatus?.phase
  // runtime 有有效（非 idle）phase 时优先；否则 streaming 回退；其余隐藏
  const phase: AgentRuntimePhase | undefined =
    runtimePhase && runtimePhase !== 'idle'
      ? runtimePhase
      : isStreamingFallback
        ? 'streaming'
        : runtimePhase
  const phaseStyle = phase && phase !== 'idle' ? PHASE_STYLE[phase] : null

  const toolStepCount = runtimeEvents.filter((event) => event.type === 'tool.started').length

  const isStreaming = phase === 'streaming'
  const toolName = runtimeStatus?.toolName

  return (
    <div className="flex items-center gap-3 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] px-4 py-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-[14px] font-medium text-foreground truncate">
          {thread?.title ?? '新会话'}
        </span>
        <ThreadMoreActions threadId={threadId} readOnly={readOnly} />
        {phaseStyle && (
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-full bg-[var(--lume-bg-elevated)] px-2 py-0.5 text-[11px] font-medium flex-shrink-0',
              phaseStyle.text
            )}
          >
            <span className={cn('size-1.5 rounded-full', phaseStyle.dot)} />
            {isStreaming && toolName
              ? `第 ${toolStepCount} 步 · ${toolName}`
              : phaseStyle.label}
            {runtimeStatus?.queuedCount ? ` · 队列 ${runtimeStatus.queuedCount}` : ''}
          </span>
        )}
      </div>
    </div>
  )
}
