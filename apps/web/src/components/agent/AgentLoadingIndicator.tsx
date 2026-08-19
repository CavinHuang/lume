/**
 * AgentLoadingIndicator — 像素网格加载指示器
 *
 * 视觉源自 beautifului.dev 的 Loading State（MIT），改造点：
 * token 对齐 Lume、shimmer 复用既有 .lume-shimmer-text、
 * 计时由自增计数改为 startedAt 时间戳驱动（复用 formatRunningDuration，
 * 1s 步进对齐 RunningDurationClock，重挂载不重置）。
 *
 * 变体：drive=方形波前 / dots=圆点波前 / orbit=彗星绕边。
 * label 可省（工具行内已有"执行中"徽章时不重复）。
 */

import { memo, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatRunningDuration } from '@/lib/format-duration'

export type AgentLoadingVariant = 'drive' | 'dots' | 'orbit'

/** 9 格延迟表：波前按 (列+|行-1|) 错相 90ms；orbit 沿周长 110ms 步进。 */
const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3)
  const col = i % 3
  return (col + Math.abs(row - 1)) * 90
})

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const ORBIT_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const step = ORBIT_ORDER.indexOf(i)
  return step === -1 ? null : step * 110
})

const PATTERNS: Record<AgentLoadingVariant, { delays: Array<number | null>; durationMs: number; round: boolean }> = {
  drive: { delays: CHEVRON_DELAYS, durationMs: 650, round: false },
  dots: { delays: CHEVRON_DELAYS, durationMs: 650, round: true },
  orbit: { delays: ORBIT_DELAYS, durationMs: 950, round: false },
}

export interface AgentLoadingIndicatorProps {
  /** shimmer 标签文本，省略则只渲染网格+计时 */
  label?: string
  variant?: AgentLoadingVariant
  /** 运行起始时间戳（ISO 字符串）；缺省不显示计时 */
  startedAt?: string
  className?: string
}

export const AgentLoadingIndicator = memo(function AgentLoadingIndicator({
  label,
  variant = 'drive',
  startedAt,
  className,
}: AgentLoadingIndicatorProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const { delays, durationMs, round } = PATTERNS[variant]
  const elapsedText = startedAt ? formatRunningDuration(Math.max(0, now - Date.parse(startedAt))) : ''

  return (
    <span
      data-agent-loading-indicator
      className={cn('inline-flex items-center gap-1.5 text-[var(--lume-text-muted)]', className)}
    >
      <span aria-hidden className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {delays.map((delay, index) => (
          <span
            key={index}
            className={cn('size-[4px] bg-[var(--lume-text-muted)]', round ? 'rounded-full' : 'rounded-[1px]')}
            style={{
              opacity: delay === null ? 0.07 : 0.15,
              animation: delay === null ? 'none' : `lume-pixel-on ${durationMs}ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </span>
      {label ? <span className="lume-shimmer-text text-[13px] font-medium">{label}</span> : null}
      {elapsedText ? <span className="font-mono text-[11px] tabular-nums">{elapsedText}</span> : null}
    </span>
  )
})
