import { useEffect, useRef, useState } from 'react'
import { buildAnchor, rectOf } from './anchor'
import type { GuestBridge } from './guest-state'

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number } // 与 anchor.ts Rect 同构
export type PreviewData = { body: string; annotationId: string; rect: Rect }

export type InteractionState = {
  hoverRect: Rect | null
  cursorPos: Point | null
  preview: PreviewData | null
  refreshKey: number
  marker: {
    enter: (body: string, annotationId: string, markerRect: Rect) => void
    leave: () => void
    click: (annotationId: string, anchor: Record<string, unknown>) => void
  }
}

export type UseAnnotationInteractionOptions = {
  bridge: GuestBridge
  mode: 'browse' | 'comment'
  purpose: 'annotation' | 'tweaks'
  host: HTMLElement | null
  generation: number
  win: Window
}

// comment 模式才捕获交互；overlay 自身元素（marker/preview 等）的点击不触发新建。
function isOverlayTarget(target: unknown, host: HTMLElement | null): boolean {
  return target instanceof Element && host !== null && host.contains(target)
}

// 交互捕获核心 hook：注册 document 捕获阶段监听器，管理 hover/cursor/preview 状态。
// 对齐 guest（browser-guest-preload.ts）的反向架构——host pointer-events:none，
// document capture listener 在 comment 模式拦截页面事件。handler 逻辑由后续 task 填充。
// TODO(follow-up): anchor-state 上报（marker 定位后发 {type:'anchor-state',annotationId,status,rect}），
//   Plan 4 退役 popup 后再评估是否需要；当前 marker 视觉状态已由 attached/stale/detached CSS 类体现。
export function useAnnotationInteraction(opts: UseAnnotationInteractionOptions): InteractionState {
  const { bridge, mode, purpose, host, generation, win } = opts
  const [hoverRect, setHoverRect] = useState<Rect | null>(null)
  const [cursorPos, setCursorPos] = useState<Point | null>(null)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  // scroll/resize/DOM 变更时自增，强制 Marker（key 含 refreshKey）重挂重算 locateAnchor
  const [refreshKey, setRefreshKey] = useState(0)
  const optsRef = useRef(opts)
  optsRef.current = opts
  // region 拖拽起点（pointerdown 记录，pointerup 消费）；null 表示未拖拽
  const draggingRef = useRef<{ x: number; y: number } | null>(null)
  // region 拖拽完成后置 true，阻止同周期 click 触发 element 新建（对齐 guest suppressNextClick L268-269）
  const suppressNextClickRef = useRef(false)

  useEffect(() => {
    // 只在 comment 模式挂交互（mode 变化时 effect 重跑，自动清理重挂）
    if (mode !== 'comment') return

    const onPointerDown = (event: PointerEvent): void => {
      if (purpose === 'tweaks' || event.button !== 0 || isOverlayTarget(event.target, optsRef.current.host)) return
      // 记录 region 拖拽起点（对齐 guest onPointerDown L215-218）
      draggingRef.current = { x: event.clientX, y: event.clientY }
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (purpose === 'tweaks' || isOverlayTarget(event.target, optsRef.current.host)) return
      const element = event.target instanceof Element ? event.target : win.document.elementFromPoint(event.clientX, event.clientY)
      if (!(element instanceof Element)) return
      setHoverRect(rectOf(element))
      setCursorPos({ x: Math.max(4, Math.min(win.innerWidth - 32, event.clientX + 14)), y: Math.max(4, Math.min(win.innerHeight - 32, event.clientY + 14)) })
    }
    const onPointerOut = (event: PointerEvent): void => {
      // 鼠标真正离开窗口（无 relatedTarget）时清除 hover/cursor
      if (event.relatedTarget !== null) return
      setHoverRect(null)
      setCursorPos(null)
    }
    const onPointerUp = (event: PointerEvent): void => {
      // region 拖拽终点：消费起点，计算 rect；<6px 视为点击交给 click handler（对齐 guest onPointerUp L262-272）
      const start = draggingRef.current
      draggingRef.current = null
      if (event.button !== 0 || !start || isOverlayTarget(event.target, optsRef.current.host)) return
      const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) }
      if (rect.width < 6 || rect.height < 6) return // 视为点击，由 click handler 处理
      event.preventDefault(); event.stopImmediatePropagation()
      // 置 suppress 标志阻止同周期 click 重复新建；setTimeout(0) 在本轮事件循环结束后复位
      suppressNextClickRef.current = true
      win.setTimeout(() => { suppressNextClickRef.current = false }, 0)
      const o = optsRef.current
      const anchor = buildAnchor('region', rect, null, undefined, o.generation, [], o.win)
      o.bridge.send({ type: 'open-editor', annotationId: undefined, purpose, anchor })
    }
    const onClick = (event: MouseEvent): void => {
      if (purpose === 'tweaks') return
      // region 拖拽刚完成 → 抑制同周期 click（对齐 guest suppressNextClick L276）
      if (suppressNextClickRef.current) { event.preventDefault(); event.stopImmediatePropagation(); return }
      if (isOverlayTarget(event.target, optsRef.current.host)) return
      // 有文本选区时让 mouseup/text 流程接管（对齐 guest onClick L277）
      const selection = win.getSelection()
      if (selection?.toString().trim()) return
      const element = event.target instanceof Element ? event.target : win.document.elementFromPoint(event.clientX, event.clientY)
      if (!(element instanceof Element) || isOverlayTarget(element, optsRef.current.host)) return
      event.preventDefault(); event.stopImmediatePropagation()
      const o = optsRef.current
      const anchor = buildAnchor('element', rectOf(element), element, undefined, o.generation, [], o.win)
      o.bridge.send({ type: 'open-editor', annotationId: undefined, purpose, anchor })
    }
    const onMouseUp = (): void => {
      // comment 模式 mouseup：非空文本选区 → text anchor → open-editor（对齐 guest openTextSelection L285-293）
      if (purpose === 'tweaks') return
      const selection = win.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return
      const range = selection.getRangeAt(0)
      const rect = rectOf(range)
      if (rect.width <= 0 || rect.height <= 0) return
      const container = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
      const o = optsRef.current
      const anchor = buildAnchor('text', rect, container ?? null, selection.toString(), o.generation, [], o.win, range)
      o.bridge.send({ type: 'open-editor', annotationId: undefined, purpose, anchor })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // ESC → mode-changed:browse（对齐 guest onKeyDown L220-225）
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      optsRef.current.bridge.send({ type: 'mode-changed', mode: 'browse' })
    }

    const capture = true
    win.document.addEventListener('pointerdown', onPointerDown, capture)
    win.document.addEventListener('pointermove', onPointerMove, capture)
    win.document.addEventListener('pointerout', onPointerOut, capture)
    win.document.addEventListener('pointerup', onPointerUp, capture)
    win.document.addEventListener('click', onClick, capture)
    win.document.addEventListener('mouseup', onMouseUp, capture)
    win.document.addEventListener('keydown', onKeyDown, capture)
    // scroll/resize/DOM 变更 → rAF 去重 → 清 hover/cursor（让其下次 pointermove 重算；marker 由 React 重渲自动重定位）
    let scheduled = false
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      win.requestAnimationFrame(() => { scheduled = false; setHoverRect(null); setCursorPos(null); setRefreshKey((k) => k + 1) })
    }
    // scroll 不冒泡：capture=true 捕获嵌套滚动（对齐 guest L133）
    win.addEventListener('scroll', schedule, true)
    win.addEventListener('resize', schedule)
    const mo = new (win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver(schedule)
    mo.observe(win.document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    return () => {
      win.document.removeEventListener('pointerdown', onPointerDown, capture)
      win.document.removeEventListener('pointermove', onPointerMove, capture)
      win.document.removeEventListener('pointerout', onPointerOut, capture)
      win.document.removeEventListener('pointerup', onPointerUp, capture)
      win.document.removeEventListener('click', onClick, capture)
      win.document.removeEventListener('mouseup', onMouseUp, capture)
      win.document.removeEventListener('keydown', onKeyDown, capture)
      win.removeEventListener('scroll', schedule, true)
      win.removeEventListener('resize', schedule)
      mo.disconnect()
      // 卸载时清 preview 定时器（Plan 3 follow-up #3：防止 marker.enter/leave 残留 timer 在组件卸载后回调）
      if (previewTimerRef.current) win.clearTimeout(previewTimerRef.current)
      if (previewHideTimerRef.current) win.clearTimeout(previewHideTimerRef.current)
    }
  }, [mode, purpose, win])

  void bridge; void generation
  // preview 显示/隐藏定时器（120ms 显示 / 260ms 隐藏）；marker 回调调度
  const previewTimerRef = useRef<ReturnType<typeof win.setTimeout> | null>(null)
  const previewHideTimerRef = useRef<ReturnType<typeof win.setTimeout> | null>(null)
  const marker = {
    enter: (body: string, annotationId: string, markerRect: Rect): void => {
      if (previewHideTimerRef.current) { win.clearTimeout(previewHideTimerRef.current); previewHideTimerRef.current = null }
      previewTimerRef.current = win.setTimeout(() => {
        // 预览卡定位：marker 左侧 -308，钳制视口；宽 300+padding ≈ 316
        const left = Math.max(8, Math.min(win.innerWidth - 316, markerRect.x - 308))
        const top = Math.max(8, Math.min(win.innerHeight - 100, markerRect.y))
        setPreview({ body, annotationId, rect: { x: left, y: top, width: 300, height: 80 } })
        optsRef.current.bridge.send({ type: 'preview-open', annotationId, rect: { x: left, y: top, width: 300, height: 80 } })
      }, 120)
    },
    leave: (): void => {
      if (previewTimerRef.current) { win.clearTimeout(previewTimerRef.current); previewTimerRef.current = null }
      previewHideTimerRef.current = win.setTimeout(() => {
        setPreview(null)
        optsRef.current.bridge.send({ type: 'preview-close' })
      }, 260)
    },
    click: (annotationId: string, anchor: Record<string, unknown>): void => {
      optsRef.current.bridge.send({ type: 'open-editor', annotationId, anchor })
    },
  }
  return { hoverRect, cursorPos, preview, refreshKey, marker }
}
