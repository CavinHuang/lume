"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  orientation?: "vertical" | "horizontal" | "both"
  /** 透传到 Viewport 的 className（与现有 Viewport className 合并）。 */
  viewportClassName?: string
  /** 透传到 Viewport 的 props（aria-*、onKeyDown、onMouseDown、role、tabIndex 等）。
   *  className 与 children 若传入会被提取并合并/忽略，请通过 viewportClassName 与 ScrollArea 的 children 传入。 */
  viewportProps?: Omit<ScrollAreaPrimitive.Viewport.Props, "ref">
  /** 消费者 ref，指向内部 Viewport DOM。与内部 scroll-detection ref 合并。 */
  viewportRef?: React.Ref<HTMLDivElement>
  /** 视觉提示：启用滚动条淡入淡出（当前实现默认即淡入淡出，prop 仅作 API 兼容）。 */
  scrollFade?: boolean
  /** CSS scrollbar-gutter：稳定布局，避免滚动条出现/消失导致内容跳动。
   *  `true` 映射为 `"stable"`；`false`/`"auto"`/省略 = 不写入（默认行为）。 */
  scrollbarGutter?: boolean | "auto" | "stable" | "both-edges"
}

function ScrollArea({
  className,
  children,
  orientation = "vertical",
  viewportClassName,
  viewportProps,
  viewportRef: consumerViewportRef,
  scrollFade,
  scrollbarGutter,
  ...props
}: ScrollAreaProps) {
  const [scrolling, setScrolling] = React.useState(false)
  const idleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const internalViewportRef = React.useRef<HTMLDivElement | null>(null)

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

  // 合并内部 scroll-detection ref 与消费者 ref，确保两者指向同一 Viewport DOM。
  const setViewportRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      internalViewportRef.current = node
      if (typeof consumerViewportRef === "function") {
        consumerViewportRef(node)
      } else if (consumerViewportRef) {
        ;(
          consumerViewportRef as React.MutableRefObject<HTMLDivElement | null>
        ).current = node
      }
    },
    [consumerViewportRef]
  )

  React.useEffect(() => {
    const viewport = internalViewportRef.current
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

  const {
    className: viewportPropsClassName,
    style: viewportPropsStyle,
    children: viewportPropsChildren,
    ...restViewportProps
  } = viewportProps ?? {}

  // 消费者不传 children 到 viewportProps（应通过 ScrollArea 的 children 传入）；
  // 忽略 viewportPropsChildren 以避免覆盖。
  void viewportPropsChildren

  // scrollbarGutter 映射：true → "stable"，false/"auto"/省略 → 不写入。
  const gutterCssValue: React.CSSProperties["scrollbarGutter"] | undefined =
    scrollbarGutter === true
      ? "stable"
      : scrollbarGutter === false ||
        scrollbarGutter === undefined ||
        scrollbarGutter === "auto"
        ? undefined
        : scrollbarGutter
  const mergedViewportStyle: React.CSSProperties | undefined =
    gutterCssValue || viewportPropsStyle
      ? { ...(gutterCssValue ? { scrollbarGutter: gutterCssValue } : {}), ...viewportPropsStyle }
      : undefined

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      data-scrolling={scrolling ? "true" : "false"}
      data-scroll-fade={scrollFade ? "true" : undefined}
      className={cn("group/scrollarea relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={setViewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "h-full w-full max-h-[inherit] max-w-[inherit] rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName,
          viewportPropsClassName
        )}
        style={mergedViewportStyle}
        {...restViewportProps}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {(orientation === "vertical" || orientation === "both") && (
        <ScrollBar orientation="vertical" />
      )}
      {(orientation === "horizontal" || orientation === "both") && (
        <ScrollBar orientation="horizontal" />
      )}
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
