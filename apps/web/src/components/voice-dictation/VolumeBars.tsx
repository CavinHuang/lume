/**
 * 听写音量波形：rAF 循环读取 volumeRef 直写各柱高度。
 *
 * 刻意不经过 React state——采集回调 ~85ms 一次，若走 setState 会以 ~12Hz
 * 重渲整个输入框子树；rAF 直写 style 只碰这几根柱子，且高度不变时跳过写入。
 */

import * as React from 'react'

const BAR_SCALES = [0.6, 1, 0.75, 0.9]
const IDLE_HEIGHT_PX = 5

/** prefers-reduced-motion 下不做持续动画，柱子静止在中位高度（仍是拾音存在的暗示）。 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function VolumeBars({ volumeRef, active, className, barClassName }: {
  volumeRef: React.RefObject<number>
  /** false 时静止在最低高度（会话结束/连接中）。 */
  active: boolean
  className?: string
  barClassName?: string
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const applyHeight = (height: string) => {
      for (const bar of Array.from(container.children)) {
        (bar as HTMLElement).style.height = height
      }
    }

    if (!active || prefersReducedMotion()) {
      applyHeight('3px')
      return
    }

    let raf = 0
    let lastHeights = ''
    const tick = () => {
      const volume = volumeRef.current ?? 0
      const heights = BAR_SCALES.map((scale) => Math.max(3, Math.round(volume * scale * 14)))
      // 高度未变化时跳过 DOM 写入（静默段大多数帧命中）。
      const signature = heights.join(',')
      if (signature !== lastHeights) {
        lastHeights = signature
        const bars = container.children
        for (let i = 0; i < bars.length; i += 1) {
          (bars[i] as HTMLElement).style.height = `${heights[i]}px`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, volumeRef])

  return (
    <div ref={containerRef} className={className} aria-hidden>
      {BAR_SCALES.map((_, index) => (
        <span
          key={index}
          className={barClassName}
          style={{ height: active ? undefined : `${IDLE_HEIGHT_PX - 2}px` }}
        />
      ))}
    </div>
  )
}
