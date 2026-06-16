import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { agentRuntimeEventsAtom, agentThreadsAtom, agentRuntimeStatusAtom } from '@/atoms'
import { WorkspacePicker } from './WorkspacePicker'
import type { AgentRuntimePhase } from '@lume/shared'

interface AgentHeaderProps {
  threadId: string
}

const PHASE_STYLE: Record<AgentRuntimePhase, { label: string; dot: string; text: string }> = {
  idle: { label: '空闲', dot: 'bg-foreground/30', text: 'text-foreground/50' },
  streaming: { label: '运行中', dot: 'bg-blue-500 animate-pulse', text: 'text-blue-600 dark:text-blue-400' },
  awaiting_permission: { label: '等待授权', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  awaiting_user_answer: { label: '等待回答', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  compacting: { label: '压缩中', dot: 'bg-purple-500 animate-pulse', text: 'text-purple-600 dark:text-purple-400' },
  completed: { label: '已完成', dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400' },
  errored: { label: '出错', dot: 'bg-destructive', text: 'text-destructive' },
}

export function AgentHeader({ threadId }: AgentHeaderProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const thread = threads.find((t) => t.id === threadId)
  const runtimeStatus = useAtomValue(agentRuntimeStatusAtom)[threadId]
  const runtimeEvents = useAtomValue(agentRuntimeEventsAtom)[threadId]?.events ?? []

  const phase = runtimeStatus?.phase
  const phaseStyle = phase && phase !== 'idle' ? PHASE_STYLE[phase] : null

  const toolStepCount = runtimeEvents.filter((event) => event.type === 'tool.started').length

  const isStreaming = phase === 'streaming'
  const toolName = runtimeStatus?.toolName

  return (
    <div className="flex items-center px-4 py-3 border-b border-border/50 gap-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-[14px] font-medium text-foreground truncate">
          {thread?.title ?? '新会话'}
        </span>
        <WorkspacePicker />
        {phaseStyle && (
          <span
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-foreground/[0.04] text-[11px] font-medium flex-shrink-0',
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
