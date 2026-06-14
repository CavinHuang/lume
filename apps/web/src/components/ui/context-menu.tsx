import { ContextMenu } from "@base-ui/react/context-menu"
import { Menu } from "@base-ui/react/menu"
import { cn } from "@/lib/utils"

function ContextMenuRoot({ ...props }: ContextMenu.Root.Props) {
  return <ContextMenu.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({ ...props }: ContextMenu.Trigger.Props) {
  return <ContextMenu.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({
  className,
  children,
  ...props
}: Menu.Popup.Props & { className?: string }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner sideOffset={4} className="z-[9999]">
        <ContextMenu.Popup
          data-slot="context-menu-content"
          className={cn(
            "min-w-[140px] overflow-hidden rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_80%,transparent)] bg-[var(--surface-1)] p-1 shadow-[0_24px_48px_-32px_hsl(var(--shadow-panel)/0.5)] animate-in fade-in-0 zoom-in-95",
            className
          )}
          {...props}
        >
          {children}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  )
}

function ContextMenuItem({
  className,
  destructive,
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
    <ContextMenu.Item
      data-slot="context-menu-item"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors cursor-default",
        destructive
          ? "text-red-500 hover:bg-red-500/10"
          : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]",
        className
      )}
      onClick={onClick ?? onSelect}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className }: { className?: string }) {
  return (
    <div
      data-slot="context-menu-separator"
      className={cn("my-0.5 h-px bg-[color:color-mix(in_oklab,var(--border-strong)_40%,transparent)]", className)}
    />
  )
}

export { ContextMenuRoot as ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator }
