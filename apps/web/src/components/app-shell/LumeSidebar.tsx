import {
  Box,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Folder,
  Maximize2,
  Minimize2,
  Settings,
  SquarePen,
  Plus,
  Trash2,
  BookOpen,
  Bot,
  ListTodo,
  Sparkles,
  PlugZap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  LumeSidebarFooterActionId,
  LumeSidebarTopActionId,
  LumeSidebarViewModel,
} from './lume-sidebar-view-model'
import { WorkspaceGroupItem } from './WorkspaceGroupItem'

import { Button } from '@/components/ui/button'
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
  onArchiveThread: (threadId: string) => void
  onTrashThread: (threadId: string) => void
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
  onArchiveThread,
  onTrashThread,
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
      <aside className="flex h-full w-[72px] -ml-2 flex-col border-r border-sidebar-border bg-[var(--lume-bg-rail)] text-[var(--lume-text-primary)]">
        <div className="flex flex-col gap-2 px-3 pb-3 pt-4">
          {topItems.map((item) => (
            <Button
                variant="ghost"
              key={item.id}
              type="button"
              title={item.label}
              disabled={item.disabled}
              onClick={() => handleCollapsedItemClick(item.id, item.kind, item.workspaceId, onTopAction, onFooterAction, onSelectWorkspace)}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-[8px] border transition-colors',
                item.id === 'new-chat'
                  ? 'border-transparent bg-[var(--brand)] text-[var(--brand-foreground)]'
                  : 'border-transparent bg-transparent text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]',
                item.active && item.id !== 'new-chat' && 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--lume-bg-elevated))] text-[var(--lume-text-primary)]',
                item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-[var(--lume-text-secondary)]',
              )}
            >
              {renderIcon(item.icon, 18)}
            </Button>
          ))}
        </div>

        <div className="mx-4 h-px bg-[var(--lume-border-subtle)]" />

        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
          {workspaceItems.map((item) => (
            <Button
                variant="ghost"
              key={item.id}
              type="button"
              title={item.label}
              onClick={() => item.workspaceId && onSelectWorkspace(item.workspaceId)}
              className={cn(
                'relative flex h-11 w-11 items-center justify-center rounded-[8px] border border-transparent transition-colors',
                item.active
                  ? 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--lume-bg-elevated))] text-[var(--lume-text-primary)]'
                  : 'text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]',
              )}
            >
              {item.active && <span className="absolute left-1 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-[var(--lume-accent)]" />}
              {renderIcon(item.icon, 18)}
            </Button>
          ))}
        </div>

        <div className="flex flex-col gap-2 px-3 pb-4">
          <Button
                variant="ghost"
            type="button"
            title="展开侧边栏"
            onClick={() => onSetCollapsed(false)}
            className="flex h-11 w-11 items-center justify-center rounded-[8px] border border-transparent text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]"
          >
            <ChevronRight size={18} />
          </Button>
          {footerItems.map((item) => (
            <Button
                variant="ghost"
              key={item.id}
              type="button"
              title={item.label}
              disabled={item.disabled}
              onClick={() => handleCollapsedItemClick(item.id, item.kind, item.workspaceId, onTopAction, onFooterAction, onSelectWorkspace)}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-[8px] border border-transparent text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]',
                item.active && 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--lume-bg-elevated))] text-[var(--lume-text-primary)]',
                item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-[var(--lume-text-secondary)]',
              )}
            >
              {renderIcon(item.icon, 18)}
            </Button>
          ))}
        </div>
      </aside>
    )
  }

  return (
    <aside className="flex h-full w-[286px] min-w-[286px] -ml-2 flex-col border-r border-sidebar-border bg-[var(--lume-bg-rail)] text-[var(--lume-text-primary)]">
      <div className="flex flex-col gap-1 px-3 pb-4 pt-4">
        {model.topActions.map((action) => {
          if (action.id === 'new-chat') {
            return (
              <Button
                variant="ghost"
                key={action.id}
                type="button"
                onClick={() => onTopAction(action.id)}
                className="flex h-10 w-full items-center gap-3 rounded-[8px] bg-[var(--brand)] px-4 text-left text-[13px] font-medium text-[var(--brand-foreground)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_72%,var(--brand-2))] hover:text-[var(--brand-foreground)]"
              >
                <SquarePen size={17} />
                <span className="flex-1">新建聊天</span>
                {action.shortcut && (
                  <span className="rounded-full border border-[color:color-mix(in_oklab,var(--lume-accent-foreground)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-accent-foreground)_14%,transparent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--lume-accent-foreground)]">
                    {action.shortcut}
                  </span>
                )}
              </Button>
            )
          }

          return (
            <Button
                variant="ghost"
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={() => onTopAction(action.id)}
              className={cn(
                'flex h-9 w-full justify-start items-center gap-3 rounded-[8px] px-3.5 text-left text-[13px] transition-colors duration-150 ease-out',
                action.disabled
                  ? 'cursor-not-allowed text-[var(--lume-text-muted)] opacity-70'
                  : action.active
                    ? 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--lume-bg-elevated))] text-[var(--lume-text-primary)]'
                  : 'text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]',
              )}
            >
              <span className={cn(
                'flex size-5 items-center justify-center',
                action.disabled ? 'text-[var(--lume-text-muted)]' : action.active ? 'text-[var(--lume-accent)]' : 'text-[var(--lume-text-secondary)]',
              )}>
                {renderIcon(action.icon, 16)}
              </span>
              <span className="flex-1">{action.label}</span>
              {action.badge && (
                <span className="rounded-full border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-2 py-0.5 text-[10px] font-medium text-[var(--lume-text-muted)]">
                  {action.badge}
                </span>
              )}
            </Button>
          )
        })}
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold leading-none text-[var(--lume-text-muted)]">
            项目
          </span>
        </div>
        <div className="flex items-center gap-2 pr-1">
          <Button
                variant="ghost"
            type="button"
            title={allExpanded ? '收起全部' : '展开全部'}
            onClick={onToggleAllWorkspaces}
            className="flex size-6 items-center justify-center rounded-[8px] border border-transparent text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]"
          >
            {allExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
          <Button
                variant="ghost"
            type="button"
            title="添加项目"
            onClick={onCreateWorkspace}
            className="flex size-6 items-center justify-center rounded-[8px] border border-transparent text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]"
          >
            <Plus size={17} strokeWidth={2.1} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none">
        <div className="space-y-2 px-2.5 pb-4">
          {model.workspaces.map((workspace) => (
            <WorkspaceGroupItem
              key={workspace.id}
              id={workspace.id}
              name={workspace.name}
              isCurrent={workspace.isCurrent}
              isExpanded={workspace.isExpanded}
              pinned={workspace.pinned}
              threads={workspace.threads}
              onToggleWorkspace={onToggleWorkspace}
              onOpenThread={onOpenThread}
              onToggleThreadPin={onToggleThreadPin}
              onArchiveThread={onArchiveThread}
              onTrashThread={onTrashThread}
              onRenameThread={onRenameThread}
              onToggleWorkspacePin={onToggleWorkspacePin}
              onRenameWorkspace={onRenameWorkspace}
              onDeleteWorkspace={onDeleteWorkspace}
              onNewThread={(wsId) => onOpenThread('__welcome__', wsId)}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-[var(--lume-border-subtle)] px-3 pb-4 pt-3">
        <div className="space-y-1">
          {model.footerActions.map((action) => {
            if (action.id === 'settings') {
              return (
                <div key={action.id} className="flex h-9 items-center gap-1">
                  <Button
                variant="ghost"
                    type="button"
                    disabled={action.disabled}
                    onClick={() => onFooterAction(action.id)}
                    className={cn(
                      'flex h-full min-w-0 flex-1 justify-start items-center gap-3 rounded-[8px] px-3.5 text-left text-[13px] transition-colors duration-150 ease-out',
                      action.disabled
                        ? 'cursor-not-allowed text-[var(--lume-text-muted)] opacity-70'
                        : 'text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]',
                    )}
                  >
                    <span className="flex size-5 items-center justify-center">
                      {renderIcon(action.icon, 16)}
                    </span>
                    <span>{action.label}</span>
                  </Button>
                  <Button
                variant="ghost"
                    type="button"
                    title="收起侧边栏"
                    onClick={() => onSetCollapsed(true)}
                    className="flex size-8 items-center justify-center rounded-[8px] border border-transparent text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]"
                  >
                    <ChevronLeft size={17} />
                  </Button>
                </div>
              )
            }

            return (
              <Button
                variant="ghost"
                key={action.id}
                type="button"
                disabled={action.disabled}
                onClick={() => onFooterAction(action.id)}
                className={cn(
                  'flex h-9 w-full justify-start items-center gap-3 rounded-[8px] px-3.5 text-left text-[13px] transition-colors duration-150 ease-out',
                  action.disabled
                    ? 'cursor-not-allowed text-[var(--lume-text-muted)] opacity-70'
                    : 'text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]',
                )}
              >
                <span className="flex size-5 items-center justify-center">
                  {renderIcon(action.icon, 16)}
                </span>
                <span>{action.label}</span>
              </Button>
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
    case 'box':
      return <Box size={size} />
    case 'book-open':
      return <BookOpen size={size} />
    case 'bot':
      return <Bot size={size} />
    case 'clock':
      return <Clock3 size={size} />
    case 'list-todo':
      return <ListTodo size={size} />
    case 'sparkles':
      return <Sparkles size={size} />
    case 'plug':
      return <PlugZap size={size} />
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
