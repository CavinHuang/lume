import { memo, useState, useRef } from 'react'
import { Pin, PinOff, Pencil, Trash2, Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { ThreadItemActions } from './ThreadItemActions'
import type { LumeSidebarThreadItem } from './lume-sidebar-view-model'

interface ThreadItemProps {
  thread: LumeSidebarThreadItem
  onSelect: (id: string) => void
  onTogglePin: (id: string) => void
  onArchive: (id: string) => void
  onRename: (id: string, title: string) => void
}

export const ThreadItem = memo(function ThreadItem({
  thread,
  onSelect,
  onTogglePin,
  onArchive,
  onRename,
}: ThreadItemProps) {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const justStartedEditing = useRef(false)

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

  return (
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
        {(thread.isStreaming || thread.active) && (
          <span
            className={cn(
              'absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none',
              thread.isStreaming ? 'bg-blue-500 animate-pulse' : 'bg-[var(--brand)]',
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

        {!editing && (
          <ThreadItemActions
            updatedAt={thread.updatedAt}
            pinned={thread.pinned}
            onTogglePin={() => onTogglePin(thread.id)}
            onArchive={() => onArchive(thread.id)}
            onMenuOpenChange={() => {}}
            menuItems={menuItems}
          />
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenu>
  )
})
