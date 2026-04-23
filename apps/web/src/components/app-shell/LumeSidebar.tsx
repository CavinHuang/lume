import { useEffect, useRef, useState } from 'react'
import {
  Box,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Folder,
  FolderPlus,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type {
  LumeSidebarFooterActionId,
  LumeSidebarThreadItem,
  LumeSidebarTopActionId,
  LumeSidebarViewModel,
  LumeSidebarWorkspaceItem,
  LumeSidebarWorkspaceRow,
} from './lume-sidebar-view-model'

interface LumeSidebarProps {
  collapsed: boolean
  allExpanded: boolean
  model: LumeSidebarViewModel
  onSetCollapsed: (collapsed: boolean) => void
  onTopAction: (actionId: LumeSidebarTopActionId) => void
  onFooterAction: (actionId: LumeSidebarFooterActionId) => void
  onSelectWorkspace: (workspaceId: string) => void
  onToggleWorkspace: (workspaceId: string) => void
  onToggleAllWorkspaces: () => void
  onCreateWorkspace: () => void
  onOpenThread: (threadId: string) => void
  onToggleThreadPin: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
}

export function LumeSidebar({
  collapsed,
  allExpanded,
  model,
  onSetCollapsed,
  onTopAction,
  onFooterAction,
  onSelectWorkspace,
  onToggleWorkspace,
  onToggleAllWorkspaces,
  onCreateWorkspace,
  onOpenThread,
  onToggleThreadPin,
  onDeleteThread,
  onRenameThread,
}: LumeSidebarProps) {
  if (collapsed) {
    const topItems = model.collapsedItems.filter((item) => item.kind === 'top-action')
    const workspaceItems = model.collapsedItems.filter((item) => item.kind === 'workspace')
    const footerItems = model.collapsedItems.filter((item) => item.kind === 'footer-action')

    return (
      <aside
        className="flex h-full w-[72px] -ml-2 flex-col border-r border-[var(--border-strong)] text-[var(--text-1)]"
        style={{
          background:
            'linear-gradient(180deg, var(--surface-1) 0%, color-mix(in oklab, var(--surface-1) 72%, var(--surface-2)) 100%)',
        }}
      >
        <div className="flex flex-col gap-2 px-3 pb-3 pt-4">
          {topItems.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              disabled={item.disabled}
              onClick={() => handleCollapsedItemClick(item.id, item.kind, item.workspaceId, onTopAction, onFooterAction, onSelectWorkspace)}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-2xl border transition-colors',
                item.id === 'new-chat'
                  ? 'border-transparent bg-gradient-to-br from-[var(--brand)] to-[var(--brand-2)] text-[var(--brand-foreground)] shadow-[0_10px_24px_-18px_color-mix(in_oklab,var(--brand)_90%,transparent)]'
                  : 'border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
                item.active && item.id !== 'new-chat' && 'bg-[var(--surface-2)] text-[var(--text-1)]',
                item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-[var(--text-2)]',
              )}
            >
              {renderIcon(item.icon, 18)}
            </button>
          ))}
        </div>

        <div className="mx-4 h-px bg-[color:color-mix(in_oklab,var(--border-strong)_68%,transparent)]" />

        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
          {workspaceItems.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              onClick={() => item.workspaceId && onSelectWorkspace(item.workspaceId)}
              className={cn(
                'relative flex h-11 w-11 items-center justify-center rounded-2xl border border-transparent transition-colors',
                item.active
                  ? 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--text-1)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
              )}
            >
              {item.active && <span className="absolute left-1 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-[var(--brand)]" />}
              {renderIcon(item.icon, 18)}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2 px-3 pb-4">
          <button
            type="button"
            title="展开侧边栏"
            onClick={() => onSetCollapsed(false)}
            className="flex h-11 w-11 items-center justify-center rounded-2xl border border-transparent text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <ChevronRight size={18} />
          </button>
          {footerItems.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              disabled={item.disabled}
              onClick={() => handleCollapsedItemClick(item.id, item.kind, item.workspaceId, onTopAction, onFooterAction, onSelectWorkspace)}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-2xl border border-transparent text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
                item.active && 'bg-[var(--surface-2)] text-[var(--text-1)]',
                item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-[var(--text-3)]',
              )}
            >
              {renderIcon(item.icon, 18)}
            </button>
          ))}
        </div>
      </aside>
    )
  }

  return (
    <aside
      className="flex h-full w-[286px] min-w-[286px] -ml-2 flex-col border-r border-[var(--border-strong)] text-[var(--text-1)]"
      style={{
        background:
          'linear-gradient(180deg, var(--surface-1) 0%, color-mix(in oklab, var(--surface-1) 70%, var(--surface-2)) 100%)',
      }}
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-4">
        {model.topActions.map((action) => {
          if (action.id === 'new-chat') {
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => onTopAction(action.id)}
                className="flex h-11 w-full items-center gap-3 rounded-[1.1rem] bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)] px-4 text-left text-[13px] font-medium text-[var(--brand-foreground)] shadow-[0_20px_32px_-24px_color-mix(in_oklab,var(--brand)_75%,transparent)] transition-transform hover:translate-y-[-1px]"
              >
                <SquarePen size={17} />
                <span className="flex-1">新建聊天</span>
                {action.shortcut && (
                  <span className="rounded-full border border-white/25 bg-white/14 px-2 py-0.5 text-[10px] font-semibold tracking-[0.02em] text-white/92">
                    {action.shortcut}
                  </span>
                )}
              </button>
            )
          }

          if (action.id === 'search') {
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => onTopAction(action.id)}
                className="flex h-11 w-full items-center gap-3 rounded-[1.05rem] border border-[color:color-mix(in_oklab,var(--border-strong)_70%,transparent)] bg-[var(--surface-2)] px-4 text-left transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_22%,var(--border-strong))] hover:bg-[color:color-mix(in_oklab,var(--surface-2)_72%,var(--surface-3))]"
              >
                <Search size={16} className="text-[var(--text-3)]" />
                <span className="flex-1 text-[13px] text-[var(--text-2)]">搜索</span>
                {action.shortcut && (
                  <span className="rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_78%,transparent)] bg-[var(--surface-1)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-3)]">
                    {action.shortcut}
                  </span>
                )}
              </button>
            )
          }

          return (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={() => onTopAction(action.id)}
              className={cn(
                'flex h-10 w-full items-center gap-3 rounded-[0.95rem] px-3.5 text-left text-[13px] transition-colors',
                action.disabled
                  ? 'cursor-not-allowed text-[var(--text-3)] opacity-70'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
              )}
            >
              <span className={cn('flex size-5 items-center justify-center', action.disabled ? 'text-[var(--text-3)]' : 'text-[var(--text-2)]')}>
                {renderIcon(action.icon, 16)}
              </span>
              <span className="flex-1">{action.label}</span>
              {action.badge && (
                <span className="rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_78%,transparent)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-3)]">
                  {action.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-between px-4 pb-2 pt-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">
            工作区
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title={allExpanded ? '收起全部' : '展开全部'}
            onClick={onToggleAllWorkspaces}
            className="flex size-8 items-center justify-center rounded-xl border border-transparent text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            {allExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            title="新建工作区"
            onClick={onCreateWorkspace}
            className="flex size-8 items-center justify-center rounded-xl border border-transparent text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <FolderPlus size={15} />
          </button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pb-4">
          {model.workspaces.map((workspace) => (
            <WorkspaceTree
              key={workspace.id}
              workspace={workspace}
              onSelectWorkspace={onSelectWorkspace}
              onToggleWorkspace={onToggleWorkspace}
              onOpenThread={onOpenThread}
              onToggleThreadPin={onToggleThreadPin}
              onDeleteThread={onDeleteThread}
              onRenameThread={onRenameThread}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="border-t border-[color:color-mix(in_oklab,var(--border-strong)_50%,transparent)] px-3 pb-4 pt-3">
        <div className="space-y-1">
          {model.footerActions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={() => onFooterAction(action.id)}
              className={cn(
                'flex h-10 w-full items-center gap-3 rounded-[0.95rem] px-3.5 text-left text-[13px] transition-colors',
                action.disabled
                  ? 'cursor-not-allowed text-[var(--text-3)] opacity-70'
                  : 'text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)]',
              )}
            >
              <span className="flex size-5 items-center justify-center">
                {renderIcon(action.icon, 16)}
              </span>
              <span>{action.label}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            title="收起侧边栏"
            onClick={() => onSetCollapsed(true)}
            className="flex size-9 items-center justify-center rounded-2xl border border-transparent text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <ChevronLeft size={17} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function WorkspaceTree({
  workspace,
  onSelectWorkspace,
  onToggleWorkspace,
  onOpenThread,
  onToggleThreadPin,
  onDeleteThread,
  onRenameThread,
}: {
  workspace: LumeSidebarWorkspaceItem
  onSelectWorkspace: (workspaceId: string) => void
  onToggleWorkspace: (workspaceId: string) => void
  onOpenThread: (threadId: string) => void
  onToggleThreadPin: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
}) {
  return (
    <section className="mb-1.5">
      <button
        type="button"
        onClick={() => {
          onSelectWorkspace(workspace.id)
          onToggleWorkspace(workspace.id)
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-[1rem] px-3 py-2.5 text-left transition-colors',
          workspace.isCurrent
            ? 'bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--surface-2))] text-[var(--text-1)]'
            : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
        )}
      >
        <ChevronRight
          size={14}
          className={cn(
            'shrink-0 text-[var(--text-3)] transition-transform duration-150',
            workspace.isExpanded && 'rotate-90',
          )}
        />
        <Folder size={15} className={cn('shrink-0', workspace.isCurrent ? 'text-[var(--brand)]' : 'text-[var(--text-3)]')} />
        <span className="flex-1 truncate text-[13px] font-medium">{workspace.name}</span>
        <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-3)]">
          {workspace.count}
        </span>
      </button>

      {workspace.isExpanded && (
        <div className="mt-1 border-l border-[color:color-mix(in_oklab,var(--border-strong)_54%,transparent)] pl-3">
          {workspace.rows.map((row) => (
            <WorkspaceRowRenderer
              key={row.type === 'thread-group' ? row.id : row.id}
              row={row}
              onOpenThread={onOpenThread}
              onToggleThreadPin={onToggleThreadPin}
              onDeleteThread={onDeleteThread}
              onRenameThread={onRenameThread}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function WorkspaceRowRenderer({
  row,
  onOpenThread,
  onToggleThreadPin,
  onDeleteThread,
  onRenameThread,
}: {
  row: LumeSidebarWorkspaceRow
  onOpenThread: (threadId: string) => void
  onToggleThreadPin: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
}) {
  if (row.type === 'synthetic-thread') {
    return (
      <button
        type="button"
        onClick={() => onOpenThread(row.id)}
        className={cn(
          'mb-1 flex h-9 w-full items-center gap-2 rounded-[0.9rem] px-3 text-left text-[13px] transition-colors',
          row.active
            ? 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--text-1)]'
            : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
        )}
      >
        <SquarePen size={14} className="text-[var(--text-3)]" />
        <span>{row.label}</span>
      </button>
    )
  }

  return (
    <div className="pb-1">
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-3)]">
        {row.label}
      </div>
      <div className="space-y-1">
        {row.items.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            onOpenThread={onOpenThread}
            onToggleThreadPin={onToggleThreadPin}
            onDeleteThread={onDeleteThread}
            onRenameThread={onRenameThread}
          />
        ))}
      </div>
    </div>
  )
}

function ThreadRow({
  thread,
  onOpenThread,
  onToggleThreadPin,
  onDeleteThread,
  onRenameThread,
}: {
  thread: LumeSidebarThreadItem
  onOpenThread: (threadId: string) => void
  onToggleThreadPin: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(thread.title)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(thread.title)
  }, [thread.title])

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (shouldCloseThreadMenuForTarget(menuRef.current, triggerRef.current, event.target as Node | null)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [menuOpen])

  useEffect(() => {
    if (editing) {
      inputRef.current?.select()
    }
  }, [editing])

  const submitRename = () => {
    const nextTitle = draft.trim()
    onRenameThread(thread.id, nextTitle)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex h-9 items-center gap-1 rounded-[0.9rem] border border-[color:color-mix(in_oklab,var(--brand)_22%,transparent)] bg-[var(--surface-2)] px-2.5">
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitRename()
            if (event.key === 'Escape') {
              setDraft(thread.title)
              setEditing(false)
            }
          }}
          className="flex-1 bg-transparent text-[13px] text-[var(--text-1)] outline-none"
        />
        <button
          type="button"
          onClick={submitRename}
          className="flex size-6 items-center justify-center rounded-full text-[var(--brand)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)]"
        >
          <Check size={13} />
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(thread.title)
            setEditing(false)
          }}
          className="flex size-6 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-1)]"
        >
          <X size={13} />
        </button>
      </div>
    )
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onOpenThread(thread.id)}
        className={cn(
          'relative flex h-9 w-full items-center gap-2 overflow-hidden rounded-[0.9rem] px-3 pr-10 text-left text-[13px] transition-colors',
          thread.active
            ? 'bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--surface-2))] text-[var(--text-1)]'
            : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
        )}
      >
        {thread.active && <span className="absolute left-0 top-1.5 h-6 w-0.5 rounded-full bg-[var(--brand)]" />}
        {thread.isStreaming ? (
          <span className="relative flex size-2.5 shrink-0">
            <span className="absolute inset-0 rounded-full bg-[var(--brand)] opacity-45 animate-ping" />
            <span className="relative block size-2.5 rounded-full bg-[var(--brand)]" />
          </span>
        ) : thread.pinned ? (
          <Pin size={11} className="shrink-0 text-[var(--text-3)]" />
        ) : (
          <span className="size-2.5 shrink-0 rounded-full bg-[color:color-mix(in_oklab,var(--text-3)_22%,transparent)]" />
        )}
        <span className="truncate">{thread.title}</span>
      </button>

      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setMenuOpen((current) => !current)
        }}
        className={cn(
          'absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-3)] transition-all hover:bg-[var(--surface-3)] hover:text-[var(--text-1)]',
          'opacity-0 group-hover:opacity-100',
          menuOpen && 'opacity-100',
        )}
      >
        <MoreHorizontal size={14} />
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-1 top-full z-50 mt-1 min-w-[148px] rounded-2xl border border-[color:color-mix(in_oklab,var(--border-strong)_80%,transparent)] bg-[var(--surface-1)] p-1 shadow-[0_24px_48px_-32px_hsl(var(--shadow-panel)/0.5)]"
        >
          <ThreadMenuItem
            icon={thread.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            onClick={() => {
              onToggleThreadPin(thread.id)
              setMenuOpen(false)
            }}
          >
            {thread.pinned ? '取消置顶' : '置顶'}
          </ThreadMenuItem>
          <ThreadMenuItem
            icon={<Pencil size={13} />}
            onClick={() => {
              setEditing(true)
              setMenuOpen(false)
            }}
          >
            重命名
          </ThreadMenuItem>
          <ThreadMenuItem
            icon={<Trash2 size={13} />}
            destructive
            onClick={() => {
              onDeleteThread(thread.id)
              setMenuOpen(false)
            }}
          >
            删除
          </ThreadMenuItem>
        </div>
      )}
    </div>
  )
}

export function shouldCloseThreadMenuForTarget(
  menuElement: Pick<Node, 'contains'> | null,
  triggerElement: Pick<Node, 'contains'> | null,
  target: Node | null,
) {
  if (!target) {
    return true
  }

  return !menuElement?.contains(target) && !triggerElement?.contains(target)
}

function ThreadMenuItem({
  children,
  icon,
  destructive,
  onClick,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] transition-colors',
        destructive
          ? 'text-red-500 hover:bg-red-500/10'
          : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
      )}
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}

function handleCollapsedItemClick(
  itemId: string,
  itemKind: 'top-action' | 'workspace' | 'footer-action',
  workspaceId: string | undefined,
  onTopAction: (actionId: LumeSidebarTopActionId) => void,
  onFooterAction: (actionId: LumeSidebarFooterActionId) => void,
  onSelectWorkspace: (workspaceId: string) => void,
) {
  if (itemKind === 'workspace') {
    if (workspaceId) {
      onSelectWorkspace(workspaceId)
    }
    return
  }

  if (itemKind === 'top-action') {
    onTopAction(itemId as LumeSidebarTopActionId)
    return
  }

  onFooterAction(itemId as LumeSidebarFooterActionId)
}

function renderIcon(icon: string, size: number) {
  switch (icon) {
    case 'square-pen':
      return <SquarePen size={size} />
    case 'search':
      return <Search size={size} />
    case 'box':
      return <Box size={size} />
    case 'clock':
      return <Clock3 size={size} />
    case 'folder':
      return <Folder size={size} />
    case 'trash':
      return <Trash2 size={size} />
    case 'settings':
      return <Settings size={size} />
    default:
      return null
  }
}
