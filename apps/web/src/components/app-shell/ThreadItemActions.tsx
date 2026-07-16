import { useState, useEffect, useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

import { Button } from '@/components/ui/button'
interface ThreadItemActionsProps {
  updatedAt: number
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

export function subscribeToRelativeTimeUpdates(onUpdate: () => void): () => void {
  const timer = setInterval(onUpdate, 60_000)
  return () => clearInterval(timer)
}

export function ThreadItemActions({
  updatedAt,
  menuItems,
  onMenuOpenChange,
}: ThreadItemActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

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

  useEffect(() => subscribeToRelativeTimeUpdates(() => setNow(Date.now())), [])

  const forceVisible = menuOpen

  return (
    <div
      className="flex h-[18px] min-w-[42px] shrink-0 items-center justify-end"
      onClick={(e) => e.stopPropagation()}
    >
      <span
        title={`最后更新：${new Date(updatedAt).toLocaleString('zh-CN')}`}
        className={cn(
          'w-full whitespace-nowrap text-right text-[11px] leading-[18px] tabular-nums text-[var(--lume-text-muted)]',
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
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                type="button"
                className="size-6 rounded-md p-0 text-[var(--lume-text-muted)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] hover:text-[var(--lume-text-primary)]"
              >
                <MoreHorizontal size={14} />
              </Button>
            }
          />
          <DropdownMenuContent>
            {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
