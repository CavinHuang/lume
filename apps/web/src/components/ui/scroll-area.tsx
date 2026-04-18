"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props) {
  const [scrolling, setScrolling] = React.useState(false)
  const idleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)

  const clearIdleTimer = React.useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }, [])

  const markScrolling = React.useCallback(() => {
    setScrolling(true)
    clearIdleTimer()
    idleTimerRef.current = setTimeout(() => {
      setScrolling(false)
      idleTimerRef.current = null
    }, 480)
  }, [clearIdleTimer])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const handleScroll = () => {
      markScrolling()
    }

    viewport.addEventListener("scroll", handleScroll, { passive: true })
    return () => {
      viewport.removeEventListener("scroll", handleScroll)
      clearIdleTimer()
    }
  }, [clearIdleTimer, markScrolling])

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      data-scrolling={scrolling ? "true" : "false"}
      className={cn("group/scrollarea relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none p-px transition-[opacity,background-color] duration-200",
        "opacity-0 group-hover/scrollarea:opacity-100 group-data-[scrolling=true]/scrollarea:opacity-100",
        "data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent",
        "data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className={cn(
          "relative flex-1 rounded-full bg-[var(--app-scrollbar-thumb)] transition-colors duration-200",
          "group-hover/scrollarea:bg-[var(--app-scrollbar-thumb-active)] group-data-[scrolling=true]/scrollarea:bg-[var(--app-scrollbar-thumb-active)]"
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
