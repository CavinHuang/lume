import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useAtom } from 'jotai'
import { rightPanelLayoutAtom } from '@/atoms'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
interface RightPanelWindowControlsProps {
  className?: string
}

export function RightPanelWindowControls({ className }: RightPanelWindowControlsProps) {
  const [layout, setLayout] = useAtom(rightPanelLayoutAtom)
  const expanded = layout.mode === 'expanded'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button
                variant="ghost"
        type="button"
        disabled={!layout.open}
        onClick={() => {
          setLayout((current) => ({
            open: true,
            mode: current.mode === 'expanded' ? 'normal' : 'expanded',
          }))
        }}
        className={cn(
          'flex size-8 items-center justify-center rounded-[8px] text-[var(--lume-text-muted)] transition-colors duration-150 ease-out',
          layout.open
            ? 'hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'
            : 'cursor-not-allowed opacity-35',
        )}
        title={expanded ? '缩小右侧面板' : '扩大右侧面板'}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </Button>

      <Button
                variant="ghost"
        type="button"
        onClick={() => {
          setLayout((current) => ({
            ...current,
            open: !current.open,
            mode: current.open ? current.mode : 'normal',
          }))
        }}
        className={cn(
          'flex size-10 items-center justify-center rounded-[12px] transition-colors duration-150 ease-out',
          layout.open
            ? 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)] hover:bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_86%,var(--lume-accent-soft))]'
            : 'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]',
        )}
        title={layout.open ? '关闭右侧面板' : '打开右侧面板'}
      >
        {layout.open ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </Button>
    </div>
  )
}
