"use client"

import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

const itemVariants = cva(
  "inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1 text-xs font-medium text-[var(--lume-text-3)] transition-colors hover:bg-muted hover:text-foreground data-pressed:border-[var(--lume-focus-ring)] data-pressed:bg-[var(--lume-accent-soft)] data-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0"
)

// base-ui's ToggleGroup uses an array value + multiple prop; this wrapper
// narrows it to single-select with a scalar string value (brief's contract).
function ToggleGroup({
  value,
  onValueChange,
  className,
  children,
  ...props
}: {
  value: string
  onValueChange: (value: string) => void
  className?: string
  children: React.ReactNode
} & Pick<React.AriaAttributes, "aria-label" | "aria-labelledby">) {
  return (
    <ToggleGroupPrimitive
      value={[value]}
      onValueChange={(groupValue) => {
        if (groupValue.length > 0) {
          onValueChange(groupValue[0])
        }
      }}
      className={cn("inline-flex flex-wrap items-center gap-1", className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  value,
  className,
  children,
  disabled,
}: {
  value: string
  className?: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <TogglePrimitive
      value={value}
      disabled={disabled}
      className={cn(itemVariants(), className)}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
