/**
 * useQuotedSelection — 通用文本选区采集 hook
 *
 * 把 Proma 三处重复的「selectionchange + pointerup/keyup + 80ms 去抖」采集逻辑
 * DRY 成一个可参数化挂载的 hook。各采集源（Agent 历史 / 文件预览 / 读书…）
 * 只需提供 rootRef + 可选的选区获取/上下文提取策略。
 *
 * 设计要点：
 * - 指针拖选与键盘扩选（Shift+方向键）双通道触发
 * - 80ms 去抖避免选区过程中频繁弹菜单
 * - 排除输入框（ProseMirror / [data-input-mode]）与自身 popover 内的选区
 * - 截断信息透传给调用方（由其决定如何提示），hook 本身无副作用
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { SELECTION_ACTION_POPOVER_SELECTOR } from '@/lib/quoted-selection'

const DEFAULT_MAX_QUOTED_CHARS = 2000

export interface QuotedSelectionContext {
  messageId?: string
  messageRole?: string
  startLine?: number
  endLine?: number
}

export interface CapturedSelection extends QuotedSelectionContext {
  text: string
  /** popover 锚点 x（选区水平中心） */
  x: number
  /** popover 锚点 y（选区上方 12px，最小 12） */
  y: number
  /** 是否触发截断 */
  truncated: boolean
  /** 原始选中长度（截断前，供调用方分档提示） */
  originalLength: number
}

export interface CaptureRaw {
  text: string
  rect: DOMRect
  range: Range
}

export interface UseQuotedSelectionOptions {
  /** 监听容器（选区起点/终点必须落在此容器内） */
  rootRef: RefObject<HTMLElement | null>
  /** 是否启用采集，默认 true */
  enabled?: boolean
  /**
   * 自定义选区获取。默认 window.getSelection + 校验落点在 root 内。
   * diff/shadow DOM 场景可注入 getDeepSelection（穿透 ShadowRoot）。
   */
  getSelection?: (root: HTMLElement) => CaptureRaw | null
  /** 从选区 DOM 提取上下文（如 closest('[data-message-id]') 取 messageId/role） */
  extractContext?: (range: Range) => QuotedSelectionContext
  /** 截断上限，默认 2000 */
  maxChars?: number
}

function getElementFromNode(node: Node | null): Element | null {
  if (!node) return null
  return node instanceof Element ? node : node.parentElement
}

function normalizeSelectedText(text: string): string {
  return text.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim()
}

/** 默认选区获取：window.getSelection + 校验落点在 root 内 */
function defaultGetSelection(root: HTMLElement): CaptureRaw | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const startEl = getElementFromNode(range.startContainer)
  const endEl = getElementFromNode(range.endContainer)
  if (!startEl || !endEl || !root.contains(startEl) || !root.contains(endEl)) return null
  const text = normalizeSelectedText(sel.toString())
  if (!text) return null
  const rect = range.getBoundingClientRect()
  const firstRect = range.getClientRects()[0]
  const anchorRect = rect.width > 0 || rect.height > 0 ? rect : firstRect
  if (!anchorRect) return null
  return { text, rect: anchorRect, range }
}

export function useQuotedSelection({
  rootRef,
  enabled = true,
  getSelection = defaultGetSelection,
  extractContext,
  maxChars = DEFAULT_MAX_QUOTED_CHARS,
}: UseQuotedSelectionOptions): {
  selection: CapturedSelection | null
  clearSelection: () => void
} {
  const [selection, setSelection] = useState<CapturedSelection | null>(null)
  const pointerSelectingRef = useRef(false)
  const captureTimerRef = useRef<number | null>(null)

  const clearSelection = useCallback((): void => {
    setSelection(null)
  }, [])

  const captureSelection = useCallback((): void => {
    const root = rootRef.current
    if (!root) return
    // 排除输入框 / 自身 popover 内的选区
    const activeEl = document.activeElement
    if (activeEl?.closest?.(`.ProseMirror, [data-input-mode], ${SELECTION_ACTION_POPOVER_SELECTOR}`)) return

    const captured = getSelection(root)
    if (!captured) {
      clearSelection()
      return
    }

    const truncated = captured.text.length > maxChars
    const text = truncated ? captured.text.slice(0, maxChars) : captured.text
    const ctx = extractContext?.(captured.range) ?? {}

    setSelection({
      text,
      x: captured.rect.left + captured.rect.width / 2,
      y: Math.max(12, captured.rect.top - 12),
      truncated,
      originalLength: captured.text.length,
      ...ctx,
    })
  }, [clearSelection, extractContext, getSelection, maxChars, rootRef])

  const scheduleCaptureSelection = useCallback((): void => {
    if (captureTimerRef.current != null) {
      window.clearTimeout(captureTimerRef.current)
    }
    captureTimerRef.current = window.setTimeout(() => {
      captureTimerRef.current = null
      captureSelection()
    }, 80)
  }, [captureSelection])

  useEffect(() => {
    if (!enabled) {
      clearSelection()
      return
    }

    const onSelectionChange = (): void => {
      if (pointerSelectingRef.current) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) clearSelection()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(SELECTION_ACTION_POPOVER_SELECTOR)) return
      if (target instanceof Element && rootRef.current?.contains(target)) {
        pointerSelectingRef.current = true
        clearSelection()
        return
      }
      clearSelection()
    }
    const onPointerUp = (): void => {
      if (!pointerSelectingRef.current) return
      pointerSelectingRef.current = false
      scheduleCaptureSelection()
    }
    const onPointerCancel = (): void => {
      pointerSelectingRef.current = false
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      // 仅 Shift 扩选 / 方向键 / Home/End/Page 引起的选区变化才捕获
      if (!event.shiftKey && !['Shift', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
      scheduleCaptureSelection()
    }

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerCancel, true)
    document.addEventListener('keyup', onKeyUp, true)
    return () => {
      if (captureTimerRef.current != null) {
        window.clearTimeout(captureTimerRef.current)
        captureTimerRef.current = null
      }
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      document.removeEventListener('keyup', onKeyUp, true)
    }
  }, [clearSelection, enabled, rootRef, scheduleCaptureSelection])

  return { selection, clearSelection }
}
