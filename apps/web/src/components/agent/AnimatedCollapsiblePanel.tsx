import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const COLLAPSIBLE_PANEL_ANIMATION_MS = 300

export function useDeferredUnmount(open: boolean, delayMs = COLLAPSIBLE_PANEL_ANIMATION_MS): boolean {
  const [wasOpen, setWasOpen] = useState(open)

  useEffect(() => {
    if (open) {
      setWasOpen(true)
      return undefined
    }

    const timeoutId = globalThis.setTimeout(() => {
      setWasOpen(false)
    }, delayMs)
    return () => globalThis.clearTimeout(timeoutId)
  }, [delayMs, open])

  return open || wasOpen
}

export function AnimatedCollapsiblePanel({
  open,
  className,
  children,
}: {
  open: boolean
  className?: string
  children: ReactNode
}) {
  const [visualOpen, setVisualOpen] = useState(false)

  useEffect(() => {
    if (!open) {
      setVisualOpen(false)
      return undefined
    }

    if (typeof globalThis.requestAnimationFrame === 'function') {
      const frameId = globalThis.requestAnimationFrame(() => setVisualOpen(true))
      return () => globalThis.cancelAnimationFrame?.(frameId)
    }

    const timeoutId = globalThis.setTimeout(() => setVisualOpen(true), 0)
    return () => globalThis.clearTimeout(timeoutId)
  }, [open])

  return (
    <div
      data-state={visualOpen ? 'open' : 'closed'}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none',
        visualOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className,
      )}
      style={{ transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }}
    >
      <div className="min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  )
}
