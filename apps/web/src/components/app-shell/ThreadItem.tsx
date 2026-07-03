import { memo, useState, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Pin, PinOff, Pencil, Trash2, Archive, ChevronRight, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  agentStreamingStatesFamily,
  agentSubagentRunsFamily,
  agentRuntimeStatusFamily,
  activeTabIdAtom,
  expandedThreadIdsAtom,
  collapsedThreadIdsAtom,
} from '@/atoms'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ThreadItemActions } from './ThreadItemActions'
import { useThreadMiniMapHover, ThreadMiniMapPopover } from './ThreadMiniMapPopover'
import type { LumeSidebarThreadItem } from './lume-sidebar-view-model'

type ThreadStatus = 'blocked' | 'running' | 'completed' | 'idle'

/** 母会话状态色条 class（综合母+子状态，对齐 Proma leftAccent） */
const TREE_ACCENT_CLASS: Record<ThreadStatus, string> = {
  blocked: 'bg-[var(--lume-warning)]',
  running: 'bg-[var(--lume-accent)] animate-pulse',
  completed: 'bg-[var(--lume-success)]',
  idle: '',
}

/** 子会话 GitBranch 图标 class（随自身状态） */
const STATUS_ICON_CLASS: Record<ThreadStatus, string> = {
  blocked: 'text-[var(--lume-warning)]',
  running: 'text-[var(--lume-accent)]',
  completed: 'text-[var(--lume-success)]',
  idle: 'text-[var(--lume-text-muted)]',
}

/** 递归判断子树是否含激活会话 */
function threadContainsActive(thread: LumeSidebarThreadItem, activeId: string | null): boolean {
  if (!activeId) return false
  if (thread.id === activeId) return true
  return thread.children?.some((c) => threadContainsActive(c, activeId)) ?? false
}

interface ThreadItemProps {
  thread: LumeSidebarThreadItem
  onSelect: (id: string) => void
  onTogglePin: (id: string) => void
  onArchive: (id: string) => void
  onRename: (id: string, title: string) => void
  /** 预留开关：禁用 hover 预览浮层（对齐 Proma disableMiniMap，默认 false） */
  disableMiniMap?: boolean
}

export const ThreadItem = memo(function ThreadItem({
  thread,
  onSelect,
  onTogglePin,
  onArchive,
  onRename,
  disableMiniMap = false,
}: ThreadItemProps) {
  const streamingState = useAtomValue(agentStreamingStatesFamily(thread.id))
  const isStreaming = streamingState === 'streaming'
  const runtimeStatus = useAtomValue(agentRuntimeStatusFamily(thread.id))
  const childRuns = useAtomValue(agentSubagentRunsFamily(thread.id)) ?? []
  const activeTabId = useAtomValue(activeTabIdAtom)
  const expandedSet = useAtomValue(expandedThreadIdsAtom)
  const collapsedSet = useAtomValue(collapsedThreadIdsAtom)
  const setExpandedSet = useSetAtom(expandedThreadIdsAtom)
  const setCollapsedSet = useSetAtom(collapsedThreadIdsAtom)

  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const justStartedEditing = useRef(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const hover = useThreadMiniMapHover(600, editing || menuOpen || disableMiniMap)

  // 自身状态：blocked(awaiting) > running(streaming) > completed > idle
  const phase = runtimeStatus?.phase
  const selfStatus: ThreadStatus =
    phase === 'awaiting_permission' || phase === 'awaiting_user_answer' ? 'blocked'
      : isStreaming ? 'running'
        : phase === 'completed' ? 'completed'
          : 'idle'

  // 母会话综合：自身 + 一层子代理 runs
  // blocked 仅母自身；running 母或子运行；completed 母或子全完成；否则 idle
  const childTotal = thread.children?.length ?? 0
  const childCompleted = childRuns.filter((r) => r.status === 'completed').length
  const hasChildren = childTotal > 0
  const childRunning = childRuns.some((r) => r.status === 'running' || r.status === 'accepted')
  const childAllCompleted = childRuns.length > 0 && childRuns.every((r) => r.status === 'completed')
  const treeStatus: ThreadStatus =
    selfStatus === 'blocked' ? 'blocked'
      : selfStatus === 'running' || childRunning ? 'running'
        : selfStatus === 'completed' || childAllCompleted ? 'completed'
          : 'idle'

  // 色条：状态色优先，否则 active 用 brand，否则无
  const accentClass =
    treeStatus !== 'idle' ? TREE_ACCENT_CLASS[treeStatus]
      : thread.active ? 'bg-[var(--lume-accent)]'
        : null

  // 自动展开（对齐 Proma 双 set）：手动展开 OR（激活在子树 且 未手动收起）
  const activeChildVisible = thread.id !== activeTabId && threadContainsActive(thread, activeTabId)
  const expanded = hasChildren && (expandedSet.has(thread.id) || (activeChildVisible && !collapsedSet.has(thread.id)))

  const indent = thread.depth > 0

  const startEdit = (): void => {
    setEditTitle(thread.title)
    setEditing(true)
    justStartedEditing.current = true
    setTimeout(() => {
      justStartedEditing.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  const saveTitle = (): void => {
    if (justStartedEditing.current) return
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === thread.title) {
      setEditing(false)
      return
    }
    onRename(thread.id, trimmed)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  const menuItems = (
    MenuItem: typeof ContextMenuItem | typeof DropdownMenuItem,
    MenuSeparator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <MenuItem onSelect={() => onTogglePin(thread.id)}>
        {thread.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        {thread.pinned ? '取消置顶' : '置顶'}
      </MenuItem>
      <MenuItem onSelect={() => startEdit()}>
        <Pencil size={14} />
        重命名
      </MenuItem>
      <MenuItem onSelect={() => onArchive(thread.id)}>
        <Archive size={14} />
        归档
      </MenuItem>
      <MenuSeparator />
      <MenuItem destructive onSelect={() => onArchive(thread.id)}>
        <Trash2 size={14} />
        删除
      </MenuItem>
    </>
  )

  const toggleExpand = (e: React.MouseEvent): void => {
    e.stopPropagation()
    hover.cancelNow()
    // 双 set 互斥：收起时记入 collapsed（压制未来自动展开），展开时从 collapsed 删除
    if (expanded) {
      setExpandedSet((prev) => { const n = new Set(prev); n.delete(thread.id); return n })
      setCollapsedSet((prev) => { const n = new Set(prev); n.add(thread.id); return n })
    } else {
      setCollapsedSet((prev) => { const n = new Set(prev); n.delete(thread.id); return n })
      setExpandedSet((prev) => { const n = new Set(prev); n.add(thread.id); return n })
    }
  }

  return (
    <div
      ref={anchorRef}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      className={cn(indent && 'border-l border-l-[var(--lume-border-subtle)] ml-3')}
      style={indent ? { paddingLeft: thread.depth * 12 } : undefined}
    >
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            role="button"
            tabIndex={0}
            onClick={() => !editing && onSelect(thread.id)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              startEdit()
            }}
            className={cn(
              'group relative w-full flex items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 transition-colors duration-100 text-left',
              thread.active && 'bg-[var(--lume-accent-soft)]',
              !thread.active && 'hover:bg-[var(--lume-bg-elevated)]',
            )}
          />
        }
      >
        {accentClass && (
          <span
            className={cn('absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none', accentClass)}
            aria-hidden="true"
          />
        )}
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={saveTitle}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-transparent text-[13px] leading-5 text-[var(--lume-text-primary)] border-b border-[color:color-mix(in_oklab,var(--lume-accent)_50%,transparent)] outline-none px-0 py-0"
              maxLength={100}
            />
          ) : (
            <div className={cn(
              'truncate text-[13px] leading-[18px] flex items-center gap-1.5',
              thread.active ? 'text-[var(--lume-text-primary)] font-medium' : 'text-[var(--lume-text-secondary)]'
            )}>
              {thread.pinned && (
                <Pin size={11} className="flex-shrink-0 text-[var(--lume-accent)]" />
              )}
              {thread.isDelegate && (
                <GitBranch size={11} className={cn('flex-shrink-0', STATUS_ICON_CLASS[selfStatus])} />
              )}
              <span className="truncate">{thread.title}</span>
              {hasChildren && (
                <span className="flex-shrink-0 text-[11px] leading-4 text-[var(--lume-text-muted)]">
                  {childCompleted}/{childTotal}
                </span>
              )}
            </div>
          )}
        </div>

        {hasChildren && !editing && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={expanded ? '收起子会话' : '展开子会话'}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={toggleExpand}
                  className="flex-shrink-0 flex size-4 items-center justify-center rounded text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
                >
                  <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />
                </button>
              }
            />
            <TooltipContent side="top">{expanded ? '收起子会话' : '展开子会话'}</TooltipContent>
          </Tooltip>
        )}

        {!editing && (
          <ThreadItemActions
            updatedAt={thread.updatedAt}
            pinned={thread.pinned}
            onTogglePin={() => onTogglePin(thread.id)}
            onArchive={() => onArchive(thread.id)}
            onMenuOpenChange={setMenuOpen}
            menuItems={menuItems}
          />
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenu>
    {hasChildren && expanded && (
      <div className="flex flex-col gap-px">
        {thread.children!.map((child) => (
          <ThreadItem
            key={child.id}
            thread={child}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onArchive={onArchive}
            onRename={onRename}
          />
        ))}
      </div>
    )}
    <ThreadMiniMapPopover
      threadId={thread.id}
      title={thread.title}
      workspaceName={thread.workspaceName}
      open={hover.open}
      isLeaving={hover.isLeaving}
      anchorRef={anchorRef}
      onMouseEnter={hover.handlePanelMouseEnter}
      onMouseLeave={hover.handlePanelMouseLeave}
    />
    </div>
  )
})
