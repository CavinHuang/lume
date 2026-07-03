import { memo, useState, useRef } from 'react'
import { FolderOpen, Plus, MoreHorizontal, Pencil, Trash2, Check, X, Home, Box } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ThreadItem } from './ThreadItem'
import type { LumeSidebarSyntheticThreadRow, LumeSidebarThreadItem } from './lume-sidebar-view-model'

const THREAD_EXPAND_STEP = 10
const THREAD_PREVIEW_LIMIT = 5

interface WorkspaceGroupItemProps {
  id: string
  name: string
  isCurrent: boolean
  isExpanded: boolean
  pinned: boolean
  syntheticRow: LumeSidebarSyntheticThreadRow | null
  threads: LumeSidebarThreadItem[]
  onSelectWorkspace: (workspaceId: string) => void
  onOpenThread: (threadId: string, workspaceId?: string) => void
  onToggleThreadPin: (threadId: string) => void
  onArchiveThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
  onToggleWorkspacePin: (workspaceId: string) => void
  onRenameWorkspace: (workspaceId: string, name: string) => void
  onDeleteWorkspace: (workspaceId: string) => void
  onNewThread: (workspaceId: string) => void
}

export const WorkspaceGroupItem = memo(function WorkspaceGroupItem({
  id,
  name,
  isCurrent,
  isExpanded,
  pinned,
  syntheticRow,
  threads,
  onSelectWorkspace,
  onOpenThread,
  onToggleThreadPin,
  onArchiveThread,
  onRenameThread,
  onToggleWorkspacePin,
  onRenameWorkspace,
  onDeleteWorkspace,
  onNewThread,
}: WorkspaceGroupItemProps) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(name)
  const [extraCount, setExtraCount] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const justStartedRef = useRef(false)

  const visibleThreads = threads.slice(0, THREAD_PREVIEW_LIMIT + extraCount)
  const currentHiddenCount = Math.max(0, threads.length - visibleThreads.length)

  const startRename = (): void => {
    setDraft(name)
    setRenaming(true)
    justStartedRef.current = true
    setTimeout(() => {
      justStartedRef.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  const commitRename = (): void => {
    if (justStartedRef.current) return
    const trimmed = draft.trim()
    if (!trimmed || trimmed === name) {
      setRenaming(false)
      return
    }
    onRenameWorkspace(id, trimmed)
    setRenaming(false)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setRenaming(false)
    }
  }

  const isPersonal = name.toLowerCase() === 'personal'

  return (
    <section className={cn('relative py-0.5 rounded-md', !isExpanded && 'mb-1')}>
      <div className="group/workspace relative flex items-center">
        {renaming ? (
          <div
            className={cn(
              'relative flex-1 min-w-0 flex items-center gap-1 px-1 py-1 rounded-md text-left',
              isCurrent ? 'text-[var(--lume-text-primary)]' : 'text-[var(--lume-text-secondary)]',
            )}
          >
            {isPersonal ? <Home size={13} className="flex-shrink-0 text-[var(--lume-text-muted)]" /> : <FolderOpen size={13} className="flex-shrink-0 text-[var(--lume-text-muted)]" />}
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              className="flex-1 min-w-0 bg-transparent text-[13px] font-medium text-[var(--lume-text-primary)] border-b border-[color:color-mix(in_oklab,var(--lume-accent)_50%,transparent)] outline-none px-0.5 leading-[18px]"
              maxLength={50}
            />
            <button
              type="button"
              onClick={commitRename}
              className="flex size-5 items-center justify-center rounded-full text-[var(--lume-accent)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_12%,transparent)]"
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={() => { setDraft(name); setRenaming(false) }}
              className="flex size-5 items-center justify-center rounded-full text-[var(--lume-text-muted)] transition-colors hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onSelectWorkspace(id)}
            className={cn(
              'relative flex-1 min-w-0 flex items-center gap-1 px-1 py-1 rounded-md text-left transition-colors duration-150 ease-out group-hover/workspace:pr-11 hover:bg-[var(--lume-bg-elevated)]',
              isCurrent
                ? 'text-[var(--lume-text-primary)]'
                : 'text-[var(--lume-text-secondary)] hover:text-[var(--lume-text-primary)]',
            )}
          >
            {isPersonal
              ? <Home size={13} strokeWidth={2} className={cn('flex-shrink-0', isCurrent ? 'text-[var(--lume-accent)]' : 'text-[var(--lume-text-muted)]')} />
              : <Box size={13} strokeWidth={2} className={cn('flex-shrink-0', isCurrent ? 'text-[var(--lume-accent)]' : 'text-[var(--lume-text-muted)]')} />
            }
            <span className="flex-1 min-w-0 truncate text-[13px] font-medium leading-[18px]">
              {name}
            </span>
            <span className={cn(
              'shrink-0 text-[11px] font-medium leading-none text-[var(--lume-text-muted)]',
              'group-hover/workspace:opacity-0',
            )}>
              {threads.length}
            </span>
          </button>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`在「${name}」中新建会话`}
                onClick={(e) => {
                  e.stopPropagation()
                  onNewThread(id)
                }}
                className="absolute right-5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-[var(--lume-text-secondary)] opacity-0 transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)] group-hover/workspace:opacity-100"
              >
                <Plus size={13} />
              </button>
            }
          />
          <TooltipContent side="top">在此工作区新建会话</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="工作区菜单"
                className="absolute right-0 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-[var(--lume-text-secondary)] opacity-0 transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)] group-hover/workspace:opacity-100"
              >
                <MoreHorizontal size={13} />
              </button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onToggleWorkspacePin(id)}>
              {pinned ? <Box size={14} /> : <Box size={14} />}
              {pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={startRename}>
              <Pencil size={14} />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => onDeleteWorkspace(id)}>
              <Trash2 size={14} />
              删除工作区
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isExpanded && (
        <div className="ml-4 mt-px">
          {syntheticRow && (
            <button
              type="button"
              onClick={() => onOpenThread(syntheticRow.id, syntheticRow.workspaceId)}
              className={cn(
                'group relative w-full flex items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 transition-colors duration-100 text-left',
                syntheticRow.active
                  ? 'bg-[var(--lume-accent-soft)]'
                  : 'hover:bg-[var(--lume-bg-elevated)]',
              )}
            >
              {syntheticRow.active && (
                <span
                  className="absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none bg-[var(--lume-accent)]"
                  aria-hidden="true"
                />
              )}
              <span className={cn(
                'truncate text-[13px] leading-[18px] flex items-center gap-1.5',
                syntheticRow.active ? 'text-[var(--lume-text-primary)] font-medium' : 'text-[var(--lume-text-secondary)]',
              )}>
                ✨ {syntheticRow.label}
              </span>
            </button>
          )}

          {threads.length > 0 ? (
            <div className="flex flex-col gap-1">
              {visibleThreads.map((thread) => (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  onSelect={onOpenThread}
                  onTogglePin={onToggleThreadPin}
                  onArchive={onArchiveThread}
                  onRename={onRenameThread}
                />
              ))}

              {currentHiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setExtraCount((prev) => prev + THREAD_EXPAND_STEP)}
                  className="w-full text-left px-1.5 py-1 rounded-md text-[12px] text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
                >
                  显示更多（{currentHiddenCount}）
                </button>
              )}

              {extraCount > 0 && (
                <button
                  type="button"
                  onClick={() => setExtraCount(0)}
                  className="w-full text-left px-1.5 py-1 rounded-md text-[12px] text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
                >
                  收起
                </button>
              )}
            </div>
          ) : (
            <div className="px-1.5 py-0.5 text-[12px] text-[var(--lume-text-muted)] select-none">
              暂无会话
            </div>
          )}
        </div>
      )}
    </section>
  )
})
