import { Monitor, X } from 'lucide-react'
import type { DesktopContextTarget } from '@lume/shared'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export function DesktopContextSelectionChip({
  target,
  onClear,
}: {
  target: DesktopContextTarget
  onClear?: () => void
}) {
  return (
    <div
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[color:color-mix(in_oklab,var(--brand)_22%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_7%,transparent)] p-0.5"
      title={`${target.app.name} · ${target.window.title}`}
    >
      <Badge
        variant="outline"
        className="min-w-0 max-w-[360px] border-transparent bg-transparent px-2 text-[11px] font-medium text-[var(--text-2)]"
      >
        <Monitor size={11} className="shrink-0 text-[var(--text-3)]" />
        <span className="shrink-0 text-[var(--text-3)]">上下文</span>
        <span className="min-w-0 truncate text-[var(--text-1)]">{target.app.name}</span>
        <span className="shrink-0 text-[var(--text-3)]">·</span>
        <span className="min-w-0 truncate">{target.window.title}</span>
      </Badge>
      {onClear ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            'size-5 rounded-full text-[var(--text-3)]',
            'hover:bg-[color:color-mix(in_oklab,var(--brand)_14%,transparent)] hover:text-[var(--text-1)]',
          )}
          aria-label="移除当前应用上下文"
          title="移除当前应用上下文"
          onClick={onClear}
        >
          <X size={11} />
        </Button>
      ) : null}
    </div>
  )
}
