import { memo, useState, useRef } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, Plus, MoreHorizontal, Pencil, Trash2, Check, X, Home, Box } from 'lucide-react'
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
import type { LumeSidebarThreadItem } from './lume-sidebar-view-model'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
const THREAD_EXPAND_STEP = 10
const THREAD_PREVIEW_LIMIT = 5

interface WorkspaceGroupItemProps {
  id: string
  name: string
  isCurrent: boolean
  isExpanded: boolean
  pinned: boolean
  threads: LumeSidebarThreadItem[]
  onToggleWorkspace: (workspaceId: string) => void
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
  threads,
  onToggleWorkspace,
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
    <section
      className={cn(
        'relative rounded-lg transition-colors duration-150 ease-out',
        !isExpanded && 'mb-1',
      )}
    >
      <div className="group/workspace relative flex h-8 items-center">
        {renaming ? (
          <div
            className={cn(
              'relative flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-left',
              isCurrent ? 'text-[var(--lume-text-primary)]' : 'text-[var(--lume-text-secondary)]',
            )}
          >
            {isPersonal ? <Home size={13} className="shrink-0 text-[var(--lume-text-muted)]" /> : <FolderOpen size={13} className="shrink-0 text-[var(--lume-text-muted)]" />}
            <Input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              className="h-7 min-w-0 flex-1 rounded-none border-0 border-b border-[color:color-mix(in_oklab,var(--lume-accent)_50%,transparent)] bg-transparent px-0.5 py-0 text-[13px] font-medium leading-[18px] text-[var(--lume-text-primary)] outline-none focus-visible:ring-0"
              maxLength={50}
            />
            <Button
              variant="ghost"
              type="button"
              onClick={commitRename}
              className="size-6 rounded-md p-0 text-[var(--lume-accent)] hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_12%,transparent)]"
            >
              <Check size={12} />
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => { setDraft(name); setRenaming(false) }}
              className="size-6 rounded-md p-0 text-[var(--lume-text-muted)] hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]"
            >
              <X size={12} />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            type="button"
            data-expanded={isExpanded}
            onClick={() => onToggleWorkspace(id)}
            className={cn(
              'h-8 min-w-0 flex-1 shrink justify-start gap-2 rounded-lg bg-transparent px-2 text-left transition-colors duration-150 ease-out group-hover/workspace:pr-14 hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)]',
              isCurrent
                ? 'text-[var(--lume-text-primary)]'
                : 'text-[var(--lume-text-secondary)] hover:text-[var(--lume-text-primary)]',
            )}
          >
            {isPersonal
              ? <Home size={14} strokeWidth={2} className={cn('shrink-0', isCurrent ? 'text-[var(--lume-accent)]' : 'text-[var(--lume-text-muted)]')} />
              : <Box size={14} strokeWidth={2} className={cn('shrink-0', isCurrent ? 'text-[var(--lume-accent)]' : 'text-[var(--lume-text-muted)]')} />
            }
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <span className="min-w-0 truncate text-[13px] font-semibold leading-[18px]">
                {name}
              </span>
              <span
                className="flex size-4 shrink-0 items-center justify-center text-[var(--lume-text-muted)] opacity-0 transition-opacity duration-150 group-hover/workspace:opacity-100"
                aria-hidden="true"
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            </span>
            <span className={cn(
              'px-1 text-[11px] font-semibold leading-none text-[var(--lume-text-muted)]',
              'group-hover/workspace:opacity-0',
            )}>
              {threads.length}
            </span>
          </Button>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                type="button"
                aria-label={`在「${name}」中新建会话`}
                onClick={(e) => {
                  e.stopPropagation()
                  onNewThread(id)
                }}
                className="absolute right-8 top-1/2 size-6 -translate-y-1/2 rounded-md p-0 text-[var(--lume-text-secondary)] opacity-0 transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)] group-hover/workspace:opacity-100"
              >
                <Plus size={13} />
              </Button>
            }
          />
          <TooltipContent side="top">在此项目中新建会话</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                type="button"
                aria-label="项目菜单"
                className="absolute right-2 top-1/2 size-6 -translate-y-1/2 rounded-md p-0 text-[var(--lume-text-secondary)] opacity-0 transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)] group-hover/workspace:opacity-100"
              >
                <MoreHorizontal size={13} />
              </Button>
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
              移除项目
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isExpanded && (
        <div className="mt-0.5 pb-1">
          {threads.length > 0 ? (
            <div className="flex flex-col gap-0.5">
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
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setExtraCount((prev) => prev + THREAD_EXPAND_STEP)}
                  className="mt-1 h-8 w-full justify-center rounded-lg bg-transparent px-2 text-[12px] font-medium text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]"
                >
                  显示更多（{currentHiddenCount}）
                </Button>
              )}

              {extraCount > 0 && (
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setExtraCount(0)}
                  className="h-8 w-full justify-center rounded-lg bg-transparent px-2 text-[12px] font-medium text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]"
                >
                  收起
                </Button>
              )}
            </div>
          ) : (
            <div className="select-none px-2 py-2 text-[12px] text-[var(--lume-text-muted)]">
              暂无会话
            </div>
          )}
        </div>
      )}
    </section>
  )
})
