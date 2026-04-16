import { useAtom, useAtomValue } from 'jotai'
import { FolderOpen, ListTodo } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentSidePanelViewAtom, agentThreadsAtom, agentRuntimeStatusAtom, type SidePanelView } from '@/atoms'
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
  const [sidePanelViews, setSidePanelViews] = useAtom(agentSidePanelViewAtom)
  const currentView = sidePanelViews[threadId] ?? null

  const toggle = (view: SidePanelView) => {
    setSidePanelViews((prev) => {
      const next = { ...prev }
      // 保留最近 50 个
      const keys = Object.keys(next)
      if (keys.length > 50) delete next[keys[0]]
      next[threadId] = next[threadId] === view ? null : view
      return next
    })
  }

  const phase = runtimeStatus?.phase
  const phaseStyle = phase && phase !== 'idle' ? PHASE_STYLE[phase] : null

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 gap-3">
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
            title={runtimeStatus?.toolName ? `工具: ${runtimeStatus.toolName}` : undefined}
          >
            <span className={cn('size-1.5 rounded-full', phaseStyle.dot)} />
            {phaseStyle.label}
            {runtimeStatus?.queuedCount ? ` · 队列 ${runtimeStatus.queuedCount}` : ''}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => toggle('files')}
          className={cn(
            'p-1.5 rounded-lg transition-colors',
            currentView === 'files'
              ? 'bg-foreground/10 text-foreground'
              : 'text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.04]'
          )}
          title="文件浏览器"
        >
          <FolderOpen size={16} />
        </button>
        <button
          onClick={() => toggle('plan')}
          className={cn(
            'p-1.5 rounded-lg transition-colors',
            currentView === 'plan'
              ? 'bg-foreground/10 text-foreground'
              : 'text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.04]'
          )}
          title="Plan 步骤"
        >
          <ListTodo size={16} />
        </button>
      </div>
    </div>
  )
}
