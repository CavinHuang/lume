import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useAtom } from 'jotai'
import { rightPanelLayoutAtom } from '@/atoms'
import { cn } from '@/lib/utils'

interface RightPanelWindowControlsProps {
  className?: string
}

export function RightPanelWindowControls({ className }: RightPanelWindowControlsProps) {
  const [layout, setLayout] = useAtom(rightPanelLayoutAtom)
  const expanded = layout.mode === 'expanded'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        type="button"
        disabled={!layout.open}
        onClick={() => {
          setLayout((current) => ({
            open: true,
            mode: current.mode === 'expanded' ? 'normal' : 'expanded',
          }))
        }}
        className={cn(
          'flex size-8 items-center justify-center rounded-[8px] text-foreground/55 transition-colors',
          layout.open
            ? 'hover:bg-foreground/[0.06] hover:text-foreground'
            : 'cursor-not-allowed opacity-35',
        )}
        title={expanded ? '缩小右侧面板' : '扩大右侧面板'}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>

      <button
        type="button"
        onClick={() => {
          setLayout((current) => ({
            ...current,
            open: !current.open,
            mode: current.open ? current.mode : 'normal',
          }))
        }}
        className={cn(
          'flex size-10 items-center justify-center rounded-[12px] transition-colors',
          layout.open
            ? 'bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.12]'
            : 'text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground',
        )}
        title={layout.open ? '关闭右侧面板' : '打开右侧面板'}
      >
        {layout.open ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>
    </div>
  )
}
