import { useState, useEffect, useRef } from 'react'
import { Pin, PinOff, Archive, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

interface ThreadItemActionsProps {
  updatedAt: number
  pinned: boolean
  onTogglePin: () => void
  onArchive: () => void
  menuItems: (
    MenuItem: typeof DropdownMenuItem,
    MenuSeparator: typeof DropdownMenuSeparator,
  ) => React.ReactNode
  onMenuOpenChange?: (open: boolean) => void
}

function formatRelativeUpdatedAt(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}分钟`
  if (diff < day) return `${Math.floor(diff / hour)}小时`
  if (diff < 30 * day) return `${Math.floor(diff / day)}天`
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}月`
  return `${Math.floor(diff / (365 * day))}年`
}

export function ThreadItemActions({
  updatedAt,
  pinned,
  onTogglePin,
  onArchive,
  menuItems,
  onMenuOpenChange,
}: ThreadItemActionsProps) {
  const [archiveConfirming, setArchiveConfirming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const now = Date.now()

  useEffect(() => {
    if (!archiveConfirming) return
    const timer = setTimeout(() => setArchiveConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [archiveConfirming])

  const handleArchiveClick = (): void => {
    if (archiveConfirming) {
      setArchiveConfirming(false)
      onArchive()
      return
    }
    setArchiveConfirming(true)
  }

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMenuOpenChange = (open: boolean): void => {
    if (open) {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      setMenuOpen(true)
    } else {
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        setMenuOpen(false)
      }, 200)
    }
    onMenuOpenChange?.(open)
  }

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
    }
  }, [])

  const forceVisible = archiveConfirming || menuOpen

  return (
    <div
      className="flex-shrink-0 flex items-center h-[18px]"
      onClick={(e) => e.stopPropagation()}
    >
      <span
        title={`最后更新：${new Date(updatedAt).toLocaleString('zh-CN')}`}
        className={cn(
          'min-w-[42px] text-right text-[11px] leading-[18px] tabular-nums text-[var(--text-3)]',
          forceVisible ? 'hidden' : 'group-hover:hidden',
        )}
      >
        {formatRelativeUpdatedAt(updatedAt, now)}
      </span>
      <div
        className={cn(
          'items-center gap-0.5',
          forceVisible ? 'flex' : 'hidden group-hover:flex',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={cn(
                'p-0.5 rounded transition-colors',
                pinned
                  ? 'text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)] hover:text-[var(--brand)]'
                  : 'text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)]',
              )}
              onClick={onTogglePin}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{pinned ? '取消置顶' : '置顶'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={cn(
                'p-0.5 rounded transition-colors',
                archiveConfirming
                  ? 'text-red-500 bg-red-500/10'
                  : 'text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)]',
              )}
              onClick={handleArchiveClick}
            >
              <Archive size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {archiveConfirming ? '再次点击确认归档' : '归档'}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button className="p-0.5 rounded text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)] transition-colors">
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
