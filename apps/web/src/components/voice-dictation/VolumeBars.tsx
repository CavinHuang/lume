/**
 * 听写音量波形：rAF 循环读取 volumeRef 直写各柱高度。
 *
 * 刻意不经过 React state——采集回调 ~85ms 一次，若走 setState 会以 ~12Hz
 * 重渲整个输入框子树；rAF 直写 style 只碰这几根柱子。
 */

import * as React from 'react'

const BAR_SCALES = [0.6, 1, 0.75, 0.9]

export function VolumeBars({ volumeRef, active, className, barClassName }: {
  volumeRef: React.RefObject<number>
  /** false 时静止在最低高度（会话结束/连接中）。 */
  active: boolean
  className?: string
  barClassName?: string
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!active) {
      // 会话结束/连接中：rAF 已停，手动复位到最低高度。
      const container = containerRef.current
      if (container) {
        for (const bar of Array.from(container.children)) {
          (bar as HTMLElement).style.height = '3px'
        }
      }
      return
    }
    let raf = 0
    const tick = () => {
      const container = containerRef.current
      if (container) {
        const volume = volumeRef.current ?? 0
        const bars = container.children
        for (let i = 0; i < bars.length; i += 1) {
          const bar = bars[i] as HTMLElement
          bar.style.height = `${Math.max(3, Math.round(volume * (BAR_SCALES[i] ?? 1) * 14))}px`
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
          style={{ height: active ? undefined : '3px' }}
        />
      ))}
    </div>
  )
}
