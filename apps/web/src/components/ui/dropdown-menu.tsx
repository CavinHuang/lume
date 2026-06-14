import { Menu } from "@base-ui/react/menu"
import { cn } from "@/lib/utils"

function DropdownMenu({ ...props }: Menu.Root.Props) {
  return <Menu.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: Menu.Trigger.Props) {
  return <Menu.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  children,
  ...props
}: Menu.Popup.Props & { className?: string }) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={4} align="start" className="z-[9999]">
        <Menu.Popup
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

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator }
