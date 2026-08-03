// scrub 拖拽 number input（对齐 Codex gWo @8904954）：
//   垂直拖拽（cursor ns-resize），向上=增、向下=减。4px 阈值/步长（hGo=gGo=4），
//   clamp min/max（XWo），格式化 2 位小数（YWo）。
// 进入 scrub 锁定 body（cursor + userSelect + overscrollBehavior + scrollContainer overflowY），
// pointerUp/pointercancel 还原。
// 5c 简化：不发 design-scrub-changed（本地值调整，提交时随 design-overlay-update）。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export type UseScrubOptions = {
  value: number
  min?: number
  max?: number
  step: number
  onChange: (value: number) => void
  onScrubActive?: (active: boolean) => void
}

export type UseScrubResult = {
  onPointerDown: (e: ReactPointerEvent) => void
  scrubbing: boolean
}

// 4px 步长（hGo）= 4px 阈值（gGo）。trunc((startY - currentY) / 4) → delta 整数步。
const SCRUB_PIXEL_STEP = 4

// DesignEditor 滚动容器 data-attr（scrub 时锁 overflowY）。
const SCRUB_SCROLL_CONTAINER_SELECTOR = '[data-browser-sidebar-design-scroll-container]'

// clamp 到 [min, max]（对齐 Codex XWo）。
const clampValue = (value: number, min?: number, max?: number): number => {
  let v = value
  if (typeof min === 'number') v = Math.max(min, v)
  if (typeof max === 'number') v = Math.min(max, v)
  return v
}

// 格式化最多 2 位小数（对齐 Codex YWo，避免 0.30000000004 浮点尾差）。
const formatScrubValue = (value: number): number => Math.round(value * 100) / 100

// 锁定 body（cursor + userSelect）+ documentElement（overscrollBehavior）+ 最近 scrollContainer（overflowY）。
// 返回还原函数；pointerUp/pointercancel/unmount 调用以复位。
const lockScrubBody = (): (() => void) => {
  const body = document.body
  const docEl = document.documentElement
  const scroll = body?.querySelector(SCRUB_SCROLL_CONTAINER_SELECTOR) as HTMLElement | null
  const prevCursor = body?.style.cursor ?? ''
  const prevUserSelect = body?.style.userSelect ?? ''
  const prevOverscroll = docEl?.style.overscrollBehavior ?? ''
  const prevOverflowY = scroll?.style.overflowY ?? ''
  if (body) {
    body.style.cursor = 'ns-resize'
    body.style.userSelect = 'none'
  }
  if (docEl) docEl.style.overscrollBehavior = 'none'
  if (scroll) scroll.style.overflowY = 'hidden'
  return () => {
    if (body) {
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
    }
    if (docEl) docEl.style.overscrollBehavior = prevOverscroll
    if (scroll) scroll.style.overflowY = prevOverflowY
  }
}

export function useScrub(opts: UseScrubOptions): UseScrubResult {
  const { value, min, max, step, onChange, onScrubActive } = opts
  const [scrubbing, setScrubbing] = useState(false)
  // 拖拽会话状态：startY（pointerDown 客户端 Y）/ startValue（拖拽前的数值）/ body 还原函数。
  const sessionRef = useRef<{ startY: number; startValue: number; restore: () => void } | null>(null)
  // 最新 props → ref，保持 onPointerDown/move/up 的 identity 稳定（避免 stale closure）。
  const optsRef = useRef({ value, min, max, step, onChange, onScrubActive })
  optsRef.current = { value, min, max, step, onChange, onScrubActive }

  const onPointerMove = useCallback((e: PointerEvent) => {
    const s = sessionRef.current
    if (!s) return
    const o = optsRef.current
    // delta = trunc((startY - currentY) / 4)：向上拖（currentY < startY）→ delta 正 → 值增。
    const delta = Math.trunc((s.startY - e.clientY) / SCRUB_PIXEL_STEP)
    if (delta === 0) return // <4px 不触发（gGo 防误触）
    const next = clampValue(s.startValue + delta * o.step, o.min, o.max)
    o.onChange(formatScrubValue(next))
  }, [])

  const endScrub = useCallback(() => {
    const s = sessionRef.current
    if (!s) return
    s.restore()
    sessionRef.current = null
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endScrub)
    document.removeEventListener('pointercancel', endScrub)
    setScrubbing(false)
    optsRef.current.onScrubActive?.(false)
  }, [onPointerMove])

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    // 守卫：左键 + 主指针 + 非触摸（触摸走原生 number input 滚轮/键盘）。
    if (e.button !== 0 || !e.isPrimary || e.pointerType === 'touch') return
    // 不 preventDefault：保留 number input 点击聚焦能力；body userSelect=none 处理拖拽期间文本选中。
    // setPointerCapture：后续 move/up 即使离开元素仍归此元素（生产 Electron 支持；happy-dom 未实现，
    // 用可选链跳过）。
    const target = e.currentTarget as HTMLElement & { setPointerCapture?: (id: number) => void }
    target.setPointerCapture?.(e.pointerId)
    const restore = lockScrubBody()
    sessionRef.current = { startY: e.clientY, startValue: optsRef.current.value, restore }
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', endScrub)
    document.addEventListener('pointercancel', endScrub)
    setScrubbing(true)
    optsRef.current.onScrubActive?.(true)
  }, [onPointerMove, endScrub])

  // 卸载时清理：移除文档监听 + 还原 body（避免组件中途卸载留下泄漏）。
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        sessionRef.current.restore()
        sessionRef.current = null
      }
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', endScrub)
      document.removeEventListener('pointercancel', endScrub)
    }
  }, [onPointerMove, endScrub])

  return { onPointerDown, scrubbing }
}
