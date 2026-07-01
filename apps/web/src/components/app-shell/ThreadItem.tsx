import { memo, useState, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { Pin, PinOff, Pencil, Trash2, Archive, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentStreamingStatesFamily, agentSubagentRunsFamily } from '@/atoms'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { ThreadItemActions } from './ThreadItemActions'
import { useThreadMiniMapHover, ThreadMiniMapPopover } from './ThreadMiniMapPopover'
import type { LumeSidebarThreadItem } from './lume-sidebar-view-model'

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
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const justStartedEditing = useRef(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const hover = useThreadMiniMapHover(600, editing || menuOpen || disableMiniMap)

  const childRuns = useAtomValue(agentSubagentRunsFamily(thread.id)) ?? []
  const childTotal = thread.children?.length ?? 0
  const childCompleted = childRuns.filter((r) => r.status === 'completed').length
  const hasChildren = childTotal > 0
  const [expanded, setExpanded] = useState(false)
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
    setExpanded((v) => !v)
  }

  return (
    <div
      ref={anchorRef}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      className={cn(indent && 'border-l-2 border-l-foreground/20 ml-3')}
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
              thread.active && 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))]',
              !thread.active && 'hover:bg-[var(--surface-2)]',
            )}
          />
        }
      >
        {(isStreaming || thread.active) && (
          <span
            className={cn(
              'absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none',
              isStreaming ? 'bg-blue-500 animate-pulse' : 'bg-[var(--brand)]',
            )}
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
              className="w-full bg-transparent text-[13px] leading-5 text-[var(--text-1)] border-b border-[color:color-mix(in_oklab,var(--brand)_50%,transparent)] outline-none px-0 py-0"
              maxLength={100}
            />
          ) : (
            <div className={cn(
              'truncate text-[13px] leading-[18px] flex items-center gap-1.5',
              thread.active ? 'text-[var(--text-1)] font-medium' : 'text-[var(--text-2)]'
            )}>
              {thread.pinned && (
                <Pin size={11} className="flex-shrink-0 text-[var(--brand)]" />
              )}
              <span className="truncate">{thread.title}</span>
            </div>
          )}
        </div>

        {hasChildren && !editing && (
          <span className="flex-shrink-0 text-[11px] tabular-nums leading-none text-[var(--text-3)] group-hover:hidden">
            {childCompleted}/{childTotal}
          </span>
        )}

        {hasChildren && !editing && (
          <button
            type="button"
            aria-label={expanded ? '收起子会话' : '展开子会话'}
            onClick={toggleExpand}
            className="flex-shrink-0 flex size-4 items-center justify-center rounded text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)]"
          >
            <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />
          </button>
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
