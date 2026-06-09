import {
  Box,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Folder,
  Maximize2,
  Minimize2,
  Search,
  Settings,
  SquarePen,
  Plus,
  Trash2,
  BookOpen,
  Bot,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type {
  LumeSidebarFooterActionId,
  LumeSidebarTopActionId,
  LumeSidebarViewModel,
} from './lume-sidebar-view-model'
import { WorkspaceGroupItem } from './WorkspaceGroupItem'

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
  onOpenThread: (threadId: string, workspaceId?: string) => void
  onToggleThreadPin: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
  onToggleWorkspacePin: (workspaceId: string) => void
  onRenameWorkspace: (workspaceId: string, name: string) => void
  onDeleteWorkspace: (workspaceId: string) => void
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
  onToggleWorkspacePin,
  onRenameWorkspace,
  onDeleteWorkspace,
}: LumeSidebarProps) {
  if (collapsed) {
    const topItems = model.collapsedItems.filter((item) => item.kind === 'top-action')
    const workspaceItems = model.collapsedItems.filter((item) => item.kind === 'workspace')
    const footerItems = model.collapsedItems.filter((item) => item.kind === 'footer-action')

    return (
      <aside
        className="flex h-full w-[72px] -ml-2 flex-col border-r border-sidebar-border text-[var(--text-1)]"
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
      className="flex h-full w-[286px] min-w-[286px] -ml-2 flex-col border-r border-sidebar-border text-[var(--text-1)]"
      style={{
        background:
          'linear-gradient(180deg, color-mix(in oklab, var(--surface-1) 82%, white) 0%, color-mix(in oklab, var(--surface-1) 74%, var(--surface-2)) 100%)',
      }}
    >
      <div className="flex flex-col gap-1 px-4 pb-4 pt-4">
        {model.topActions.map((action) => {
          if (action.id === 'new-chat') {
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => onTopAction(action.id)}
                className="flex h-10 w-full items-center gap-3 rounded-xl bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)] px-4 text-left text-[13px] font-medium text-[var(--brand-foreground)] shadow-[0_16px_28px_-22px_color-mix(in_oklab,var(--brand)_78%,transparent)] transition-transform hover:translate-y-[-1px]"
              >
                <SquarePen size={17} />
                <span className="flex-1">新建聊天</span>
                {action.shortcut && (
                  <span className="rounded-full border border-white/25 bg-white/14 px-2 py-0.5 text-[10px] font-semibold text-white/92">
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
                className="flex h-10 w-full items-center gap-3 rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_70%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_74%,transparent)] px-4 text-left transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_22%,var(--border-strong))] hover:bg-[color:color-mix(in_oklab,var(--surface-2)_72%,var(--surface-3))]"
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
                'flex h-9 w-full items-center gap-3 rounded-xl px-3.5 text-left text-[13px] transition-colors',
                action.disabled
                  ? 'cursor-not-allowed text-[var(--text-3)] opacity-70'
                  : action.active
                    ? 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--brand)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
              )}
            >
              <span className={cn(
                'flex size-5 items-center justify-center',
                action.disabled ? 'text-[var(--text-3)]' : action.active ? 'text-[var(--brand)]' : 'text-[var(--text-2)]',
              )}>
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

      <div className="flex items-center justify-between px-4 pb-3 pt-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold leading-none text-[var(--text-3)]">
            工作区
          </span>
        </div>
        <div className="flex items-center gap-2 pr-1">
          <button
            type="button"
            title={allExpanded ? '收起全部' : '展开全部'}
            onClick={onToggleAllWorkspaces}
            className="flex size-6 items-center justify-center rounded-lg border border-transparent text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            {allExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            title="新建工作区"
            onClick={onCreateWorkspace}
            className="flex size-6 items-center justify-center rounded-lg border border-transparent text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <Plus size={17} strokeWidth={2.1} />
          </button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-4">
          {model.workspaces.map((workspace) => (
            <WorkspaceGroupItem
              key={workspace.id}
              id={workspace.id}
              name={workspace.name}
              isCurrent={workspace.isCurrent}
              isExpanded={workspace.isExpanded}
              pinned={workspace.pinned}
              syntheticRow={workspace.syntheticRow}
              threads={workspace.threads}
              onSelectWorkspace={onSelectWorkspace}
              onOpenThread={onOpenThread}
              onToggleThreadPin={onToggleThreadPin}
              onArchiveThread={onDeleteThread}
              onRenameThread={onRenameThread}
              onToggleWorkspacePin={onToggleWorkspacePin}
              onRenameWorkspace={onRenameWorkspace}
              onDeleteWorkspace={onDeleteWorkspace}
              onNewThread={(wsId) => onOpenThread('__welcome__', wsId)}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="border-t border-[color:color-mix(in_oklab,var(--border-strong)_50%,transparent)] px-3 pb-4 pt-3">
        <div className="space-y-1">
          {model.footerActions.map((action) => {
            if (action.id === 'settings') {
              return (
                <div key={action.id} className="flex h-9 items-center gap-1">
                  <button
                    type="button"
                    disabled={action.disabled}
                    onClick={() => onFooterAction(action.id)}
                    className={cn(
                      'flex h-full min-w-0 flex-1 items-center gap-3 rounded-xl px-3.5 text-left text-[13px] transition-colors',
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
                  <button
                    type="button"
                    title="收起侧边栏"
                    onClick={() => onSetCollapsed(true)}
                    className="flex size-8 items-center justify-center rounded-xl border border-transparent text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
                  >
                    <ChevronLeft size={17} />
                  </button>
                </div>
              )
            }

            return (
              <button
                key={action.id}
                type="button"
                disabled={action.disabled}
                onClick={() => onFooterAction(action.id)}
                className={cn(
                  'flex h-9 w-full items-center gap-3 rounded-xl px-3.5 text-left text-[13px] transition-colors',
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
            )
          })}
        </div>
      </div>
    </aside>
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
    case 'book-open':
      return <BookOpen size={size} />
    case 'bot':
      return <Bot size={size} />
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
