import { useEffect, useState, type ReactNode } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { FileText, FolderOpen, ListTodo } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { agentRuntimeEventsFamily, agentThreadsAtom, agentRuntimeStatusFamily, agentStreamingStatesFamily, agentWorkspacesAtom, activeTabIdAtom, tabsAtom } from '@/atoms'
import { ThreadMoreActions } from './ThreadMoreActions'
<<<<<<< HEAD
import { AGENT_IPC_CHANNELS, type AgentProjectInstructionsInfo, type AgentRuntimePhase, type AgentWorkspace, type AgentWorkspaceStatus } from '@lume/shared'
=======
import { displayToolName } from './message-blocks/tool-summary'
import { AGENT_IPC_CHANNELS, type AgentRuntimePhase, type AgentWorkspace, type AgentWorkspaceStatus } from '@lume/shared'
>>>>>>> upstream/main
import { getPlanningTodo, onPlanningTodoChange, openFolderDialog, sidecarCall } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'

interface AgentHeaderProps {
  threadId: string
  readOnly?: boolean
  /** 头部右侧的操作区（如 视图切换）。 */
  actions?: ReactNode
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

export function AgentHeader({ threadId, readOnly, actions }: AgentHeaderProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [, setActiveTabId] = useAtom(activeTabIdAtom)
  const thread = threads.find((t) => t.id === threadId)
  const workspace = workspaces.find((item) => item.id === thread?.workspaceId)
  const runtimeStatus = useAtomValue(agentRuntimeStatusFamily(threadId))
  const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
  const isStreamingFallback = useAtomValue(agentStreamingStatesFamily(threadId)) === 'streaming'
  const [workspaceStatus, setWorkspaceStatus] = useState<AgentWorkspaceStatus | null>(null)
  const [ordinaryPath, setOrdinaryPath] = useState<string | null>(null)
  const [primaryTodo, setPrimaryTodo] = useState<{ id: string; title: string; status: string } | null>(null)
  // #670 行为告知:项目指令注入此前完全静默,头部 chip 展示当前生效的
  // CLAUDE.md/AGENTS.md(路径与截断态在 tooltip),无指令时不渲染。
  // 已知语义:挂载时一次性查询,不订阅配置变更——用户改设置页开关或指令文件后,
  // 已打开会话的 chip 到下次进入该线程前保持旧值;tooltip 描述的是注入时刻快照。
  const [instructionsInfo, setInstructionsInfo] = useState<AgentProjectInstructionsInfo | null>(null)

  const runtimePhase = runtimeStatus?.phase
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

  useEffect(() => {
    let cancelled = false
    void sidecarCall<AgentProjectInstructionsInfo | null>(AGENT_IPC_CHANNELS.GET_PROJECT_INSTRUCTIONS_INFO, { threadId })
      .then((info) => { if (!cancelled) setInstructionsInfo(info ?? null) })
      .catch(() => { if (!cancelled) setInstructionsInfo(null) })
    return () => { cancelled = true }
  }, [threadId])

  useEffect(() => {
    // 快速切换会话时旧线程的响应可能晚到，cancelled 守卫防止覆盖新线程的状态
    // （否则头部显示错误路径，后续 OPEN_FILE 会打开错误目录）
    let cancelled = false
    if (workspace) {
      void sidecarCall<AgentWorkspaceStatus>(AGENT_IPC_CHANNELS.GET_WORKSPACE_STATUS, { id: workspace.id })
        .then((status) => { if (!cancelled) setWorkspaceStatus(status) })
        .catch(() => { if (!cancelled) setWorkspaceStatus(null) })
      setOrdinaryPath(null)
      return () => { cancelled = true }
    }
    setWorkspaceStatus(null)
    void sidecarCall<string>(AGENT_IPC_CHANNELS.GET_THREAD_PATH, { threadId })
      .then((path) => { if (!cancelled) setOrdinaryPath(path) })
      .catch(() => { if (!cancelled) setOrdinaryPath(null) })
    return () => { cancelled = true }
  }, [threadId, workspace])

  useEffect(() => {
    const todoId = thread?.planningTodoId
    if (!todoId) { setPrimaryTodo(null); return }
    let active = true
    const refresh = () => { void getPlanningTodo(todoId).then((result) => { if (active && result.todo.status === 'open' && !result.todo.deletedAt) setPrimaryTodo({ id: result.todo.id, title: result.todo.title, status: result.todo.status }); else if (active) setPrimaryTodo(null) }).catch(() => { if (active) setPrimaryTodo(null) }) }
    refresh()
    let unsubscribe: (() => void) | undefined
    void onPlanningTodoChange(() => refresh()).then((off) => { if (active) unsubscribe = off; else off() })
    return () => { active = false; unsubscribe?.() }
  }, [thread?.planningTodoId])

  const openPrimaryTodo = () => {
    if (!primaryTodo) return
    const id = `todo:${primaryTodo.id}`
    if (!tabs.some((tab) => tab.id === id)) setTabs((current) => [...current, { id, type: 'todo', title: primaryTodo.title, todoId: primaryTodo.id, workspaceId: workspace?.id }])
    setActiveTabId(id)
  }

  const handleWorkdirClick = async () => {
    if (!workspace) {
      if (!ordinaryPath) return
      await sidecarCall(AGENT_IPC_CHANNELS.OPEN_FILE, { threadId, path: ordinaryPath })
      return
    }
    if (workspaceStatus?.availability === 'available' && workspaceStatus.projectPath) {
      await sidecarCall(AGENT_IPC_CHANNELS.SHOW_PROJECT_IN_FOLDER, {
        workspaceSlug: workspace.slug,
        path: workspaceStatus.projectPath,
      })
      return
    }
    const selection = await openFolderDialog()
    if (!selection.path) return
    const channel = workspaceStatus?.availability === 'unavailable'
      ? AGENT_IPC_CHANNELS.RELOCATE_WORKSPACE_DIRECTORY
      : AGENT_IPC_CHANNELS.BIND_WORKSPACE_DIRECTORY
    const updated = await sidecarCall<AgentWorkspace>(channel, { id: workspace.id, projectPath: selection.path })
    setWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item))
    setWorkspaceStatus(await sidecarCall<AgentWorkspaceStatus>(AGENT_IPC_CHANNELS.GET_WORKSPACE_STATUS, { id: workspace.id }))
    toast.success('项目目录已绑定')
  }

  const workdirLabel = workspace
    ? workspaceStatus?.availability === 'available'
      ? workspaceStatus.projectPath
      : workspaceStatus?.availability === 'unavailable'
        ? '项目目录不可用，点击重新定位'
        : '项目尚未绑定目录，点击选择'
    : ordinaryPath ?? 'Lume 工作目录'

  return (
    <div className="flex items-center gap-3 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] px-4 py-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-[14px] font-medium text-foreground truncate">
          {thread?.title ?? '新会话'}
        </span>
        <ThreadMoreActions threadId={threadId} readOnly={readOnly} />
        {primaryTodo && <Button type="button" variant="secondary" onClick={openPrimaryTodo} className="h-7 max-w-[220px] justify-start gap-1.5 px-2 text-[11px]" title={primaryTodo.title}><ListTodo size={13} /><span className="truncate">{primaryTodo.title}</span></Button>}
        {instructionsInfo && (
          <span
            className="flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md bg-[var(--lume-bg-elevated)] px-2 text-caption text-muted-foreground"
            title={`${instructionsInfo.path}\n已注入系统提示 ${instructionsInfo.chars} 字符${instructionsInfo.truncated ? '（超出 32KB 上限已截断）' : ''}`}
          >
            <FileText size={13} className="shrink-0" />
            <span className="truncate">
              {instructionsInfo.path.split(/[\\/]/).pop()}{instructionsInfo.truncated ? ' · 已截断' : ''}
            </span>
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={() => void handleWorkdirClick().catch(() => toast.error('打开工作目录失败'))}
          className="h-7 min-w-0 max-w-[360px] justify-start gap-1.5 px-2 text-[11px] text-muted-foreground"
          title={workdirLabel ?? undefined}
        >
          <FolderOpen size={13} className="shrink-0" />
          <span className="truncate">
            {workspace
              ? `${workspace.name} · ${workdirLabel}`
              : `普通会话 · Lume 工作目录${ordinaryPath ? ` · ${ordinaryPath}` : ''}`}
          </span>
        </Button>
        {phaseStyle && (
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-full bg-[var(--lume-bg-elevated)] px-2 py-0.5 text-[11px] font-medium flex-shrink-0',
              phaseStyle.text
            )}
          >
            <span className={cn('size-1.5 rounded-full', phaseStyle.dot)} />
            {isStreaming && toolName
              ? `第 ${toolStepCount} 步 · ${displayToolName(toolName)}`
              : phaseStyle.label}
            {runtimeStatus?.queuedCount ? ` · 队列 ${runtimeStatus.queuedCount}` : ''}
          </span>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  )
}
