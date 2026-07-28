import { forwardRef } from 'react'
import { Popover } from '@base-ui/react/popover'
import { cn } from '@/lib/utils'

function PopoverRoot({ ...props }: Popover.Root.Props) {
  return <Popover.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: Popover.Trigger.Props) {
  return <Popover.Trigger data-slot="popover-trigger" {...props} />
}

const PopoverContent = forwardRef<
  HTMLDivElement,
  Popover.Popup.Props & {
    className?: string
    side?: Popover.Positioner.Props['side']
    align?: Popover.Positioner.Props['align']
    sideOffset?: number
  }
>(function PopoverContent({
  className,
  side = 'bottom',
  align = 'center',
  sideOffset = 4,
  children,
  ...props
}, ref) {
  return (
    <Popover.Portal>
      <Popover.Positioner side={side} align={align} sideOffset={sideOffset} className="z-[9999]">
        <Popover.Popup
          ref={ref}
          data-slot="popover-content"
          className={cn(
            'overflow-hidden rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_80%,transparent)] bg-[var(--surface-1)] text-[var(--text-1)] shadow-[0_24px_48px_-32px_hsl(var(--shadow-panel)/0.5)] animate-in fade-in-0 zoom-in-95',
            className,
          )}
          {...props}
        >
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  )
})

export { PopoverRoot as Popover, PopoverTrigger, PopoverContent }
