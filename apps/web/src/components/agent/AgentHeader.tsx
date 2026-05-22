import { useAtom, useAtomValue } from 'jotai'
import { FolderOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentRuntimeEventsAtom, agentSidePanelViewAtom, agentThreadsAtom, agentRuntimeStatusAtom, agentFileTreeOpenAtom } from '@/atoms'
import { WorkspacePicker } from './WorkspacePicker'
import type { AgentRuntimePhase } from '@lume/shared'

interface AgentHeaderProps {
  threadId: string
}

interface AgentSidePanelToolbarProps {
  threadId: string
  className?: string
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

export function AgentSidePanelToolbar({ threadId, className }: AgentSidePanelToolbarProps) {
  const [sidePanelViews, setSidePanelViews] = useAtom(agentSidePanelViewAtom)
  const [fileTreeOpenByThread, setFileTreeOpenByThread] = useAtom(agentFileTreeOpenAtom)
  const currentView = sidePanelViews[threadId] ?? null
  const panelOpen = currentView !== null
  const fileTreeOpen = fileTreeOpenByThread[threadId] ?? false

  const toggleSidePanel = () => {
    setSidePanelViews((prev) => {
      const next = { ...prev }
      const keys = Object.keys(next)
      if (keys.length > 50) delete next[keys[0]]
      next[threadId] = panelOpen ? null : 'files'
      return next
    })
    if (!panelOpen) {
      setFileTreeOpenByThread((prev) => ({ ...prev, [threadId]: false }))
    }
  }

  return (
    <div className={cn('flex items-center gap-1 flex-shrink-0', className)}>
      {panelOpen && (
        <button
          type="button"
          onClick={() => {
            setSidePanelViews((prev) => ({ ...prev, [threadId]: 'files' }))
            setFileTreeOpenByThread((prev) => ({ ...prev, [threadId]: !fileTreeOpen }))
          }}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors',
            currentView === 'files' && fileTreeOpen
              ? 'bg-foreground/10 text-foreground'
              : 'text-foreground/50 hover:bg-foreground/[0.04] hover:text-foreground/70',
          )}
          title={fileTreeOpen ? '收起文件树' : '展开文件树'}
        >
          <FolderOpen size={15} />
        </button>
      )}
      <button
        onClick={toggleSidePanel}
        className={cn(
          'p-1.5 rounded-lg transition-colors',
          panelOpen
            ? 'bg-foreground/10 text-foreground'
            : 'text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.04]'
        )}
        title={panelOpen ? '收起侧栏' : '展开侧栏'}
      >
        {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>
    </div>
  )
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
