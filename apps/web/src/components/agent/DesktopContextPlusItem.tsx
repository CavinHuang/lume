import { MonitorUp } from 'lucide-react'
import type { DesktopContextTarget } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function DesktopContextPlusItem({
  target,
  active,
  itemIndex,
  onHover,
  onActivate,
}: {
  target: DesktopContextTarget
  active: boolean
  itemIndex?: number
  onHover?: () => void
  onActivate: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      data-plus-item={itemIndex}
      onMouseEnter={onHover}
      onClick={onActivate}
      className={cn(
        'flex h-auto w-full items-center justify-start gap-2.5 rounded-none px-3 py-2.5 text-left transition-colors',
        active ? 'bg-[var(--lume-accent-soft)]' : 'hover:bg-[var(--surface-3)]',
      )}
    >
      <MonitorUp size={14} className="shrink-0 text-[var(--lume-accent)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[var(--text-1)]">
          {target.app.name}
        </div>
        <div className="truncate text-xs text-[var(--text-3)]">
          {target.window.title || target.app.id}
        </div>
      </div>
      <div className="shrink-0 rounded-full bg-[var(--lume-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--lume-accent)]">
        作为上下文
      </div>
    </Button>
  )
}
