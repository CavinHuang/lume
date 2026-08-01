import { forwardRef } from "react"
import { Menu } from "@base-ui/react/menu"
import { cn } from "@/lib/utils"

function DropdownMenu({ ...props }: Menu.Root.Props) {
  return <Menu.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: Menu.Trigger.Props) {
  return <Menu.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

type DropdownMenuContentProps = Menu.Popup.Props & {
  className?: string
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
  collisionPadding?: number
}

const DropdownMenuContent = forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  function DropdownMenuContent({ className, children, align = 'start', side = 'bottom', sideOffset = 4, collisionPadding = 8, ...props }, ref) {
    return (
      <Menu.Portal>
        <Menu.Positioner side={side} sideOffset={sideOffset} align={align} collisionPadding={collisionPadding} positionMethod="fixed" className="z-[9999]">
          <Menu.Popup
            ref={ref}
            data-slot="dropdown-menu-content"
            className={cn(
              "min-w-[140px] overflow-hidden rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_80%,transparent)] bg-[var(--surface-1)] p-1 shadow-[0_24px_48px_-32px_hsl(var(--shadow-panel)/0.5)] animate-in fade-in-0 zoom-in-95",
              className
            )}
            {...props}
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    )
  }
)

function DropdownMenuItem({
  className,
  destructive,
  disabled,
  onSelect,
  onClick,
  ...props
}: Omit<Menu.Item.Props, "onSelect"> & {
  className?: string
  destructive?: boolean
  /** 选择回调；base-ui MenuItem 不触发 onSelect，内部映射到 onClick。 */
  onSelect?: () => void
}) {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors cursor-default",
        destructive
          ? "text-red-500 hover:bg-red-500/10"
          : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]",
        disabled && "cursor-not-allowed opacity-45",
        className
      )}
      onClick={onClick ?? onSelect}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className }: { className?: string }) {
  return (
    <div
      data-slot="dropdown-menu-separator"
      className={cn("my-0.5 h-px bg-[color:color-mix(in_oklab,var(--border-strong)_40%,transparent)]", className)}
    />
  )
}

function DropdownMenuSub({ ...props }: Menu.SubmenuRoot.Props) {
  return <Menu.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({ className, ...props }: Menu.SubmenuTrigger.Props) {
  return (
    <Menu.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)] transition-colors cursor-default',
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSubContent({ className, children, align = 'start', side = 'right', sideOffset = 4, collisionPadding = 8, ...props }: DropdownMenuContentProps) {
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} sideOffset={sideOffset} align={align} collisionPadding={collisionPadding} positionMethod="fixed" className="z-[9999]">
        <Menu.Popup
          data-slot="dropdown-menu-sub-content"
          className={cn(
            'min-w-[140px] overflow-hidden rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_80%,transparent)] bg-[var(--surface-1)] p-1 shadow-[0_24px_48px_-32px_hsl(var(--shadow-panel)/0.5)] animate-in fade-in-0 zoom-in-95',
            className
          )}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
