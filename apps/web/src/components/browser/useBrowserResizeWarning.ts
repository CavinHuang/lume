/**
 * agent 操作期间用户 resize 的弱提示(ZCode aEt 的 Lume 移植)。
 *
 * 语义来源:.zcode/analysis/extracted/04-renderer-panel.source.js
 *   aEt:ResizeObserver 监听 browser region;agent 操作窗(browserUseOperationUntil
 *   未到期)内尺寸变化 → 显示 3s 警告(tEt=3000),每个操作窗至多一次。
 *   沉降抑制窗:基线版本变化(resetsResizeBaseline/agent viewport 变更,ZCode z1)
 *   或本地视口动作触发 notify 时,开 300ms 观察窗(nEt),滚动式 +100ms(rEt)延长、
 *   上限 500ms(iEt);窗内尺寸抖动不算用户 resize。
 *   操作窗结束(eEt 倒计时归零)即撤销警告。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** 警告显示时长(ZCode tEt=3000)。 */
const RESIZE_WARNING_MS = 3000
/** 沉降观察窗起点(ZCode nEt=300)。 */
const SETTLE_WINDOW_START_MS = 300
/** 沉降窗滚动延长步长(ZCode rEt=100)。 */
const SETTLE_WINDOW_EXTEND_MS = 100
/** 沉降抑制窗上限(ZCode iEt=500)。 */
const SETTLE_WINDOW_CAP_MS = 500

/** 操作截止时间的倒计时窗(ZCode eEt:截止前为 true,到点翻 false)。 */
export function useOperationWindowActive(operationUntil: number): boolean {
  const [checkedAt, setCheckedAt] = useState(() => Date.now())
  useEffect(() => {
    const remainMs = operationUntil - Date.now()
    if (remainMs <= 0) return
    const timer = window.setTimeout(() => setCheckedAt(Date.now()), remainMs)
    return () => window.clearTimeout(timer)
  }, [operationUntil])
  return operationUntil > checkedAt
}

export interface UseBrowserResizeWarningOptions {
  /** browser region 容器(XTt 根 div;观察其 contentRect)。 */
  containerRef: RefObject<HTMLElement>
  /** 面板可见(不可见不警告)。 */
  isVisible: boolean
  /** agent 操作窗是否生效(eEt 倒计时)。 */
  operationActive: boolean
  /** resize 基线版本(agent 操作/视口变更时 +1;变化即开沉降窗抑制)。 */
  resizeBaselineVersion: number
}

export interface UseBrowserResizeWarningResult {
  /** 本地视口动作(如切换 responsive)前调用:开沉降窗,吞掉随后的 region 抖动。 */
  notifyBrowserViewportResize: () => void
  showResizeWarning: boolean
}

export function useBrowserResizeWarning({
  containerRef,
  isVisible,
  operationActive,
  resizeBaselineVersion,
}: UseBrowserResizeWarningOptions): UseBrowserResizeWarningResult {
  const [showResizeWarning, setShowResizeWarning] = useState(false)
  const previousSizeRef = useRef<{ width: number; height: number } | null>(null)
  /** 沉降窗截止(ZCode u)/上限(ZCode d)。 */
  const settleUntilRef = useRef(0)
  const settleCapRef = useRef(0)
  /** 本操作窗已警告过(ZCode c:一次操作窗至多一次)。 */
  const warnedRef = useRef(false)
  const warningTimerRef = useRef<number | null>(null)
  const isVisibleRef = useRef(isVisible)
  isVisibleRef.current = isVisible
  const operationActiveRef = useRef(operationActive)
  operationActiveRef.current = operationActive

  /** 显示警告(可见 + agent 操作中 + 本操作窗未提示过;ZCode _)。 */
  const showWarning = useCallback(() => {
    if (!isVisibleRef.current || !operationActiveRef.current || warnedRef.current) return
    warnedRef.current = true
    setShowResizeWarning(true)
    warningTimerRef.current = window.setTimeout(() => {
      warningTimerRef.current = null
      setShowResizeWarning(false)
    }, RESIZE_WARNING_MS)
  }, [])

  /** 开沉降窗(ZCode v)。 */
  const notifyBrowserViewportResize = useCallback(() => {
    const now = Date.now()
    settleUntilRef.current = now + SETTLE_WINDOW_START_MS
    settleCapRef.current = now + SETTLE_WINDOW_CAP_MS
  }, [])

  /** 基线版本变化 → 沉降窗重置(agent 布局沉降不触发警告;ZCode useLayoutEffect)。 */
  const previousVersionRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const previous = previousVersionRef.current
    const firstBaseline = previous === null && resizeBaselineVersion > 0
    const versionChanged = previous !== null && previous !== resizeBaselineVersion
    previousVersionRef.current = resizeBaselineVersion
    if (firstBaseline || versionChanged) notifyBrowserViewportResize()
  }, [notifyBrowserViewportResize, resizeBaselineVersion])

  /** 操作窗结束 → 撤销警告并复位"已警告"标记(下一操作窗可再提示;ZCode h||分支)。 */
  useEffect(() => {
    if (operationActive) return
    warnedRef.current = false
    setShowResizeWarning(false)
    if (warningTimerRef.current !== null) {
      window.clearTimeout(warningTimerRef.current)
      warningTimerRef.current = null
    }
  }, [operationActive])

  useEffect(() => {
    const node = containerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      const size = { width: Math.round(rect.width), height: Math.round(rect.height) }
      if (size.width <= 0 || size.height <= 0) return
      const previous = previousSizeRef.current
      previousSizeRef.current = size
      const now = Date.now()
      const settling = now <= settleUntilRef.current
      if (settling) {
        settleUntilRef.current = Math.min(settleCapRef.current, Math.max(settleUntilRef.current, now + SETTLE_WINDOW_EXTEND_MS))
      }
      const sizeChanged = previous !== null && (previous.width !== size.width || previous.height !== size.height)
      if (!sizeChanged || settling) return
      showWarning()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [containerRef, showWarning])

  useEffect(() => () => {
    if (warningTimerRef.current !== null) window.clearTimeout(warningTimerRef.current)
  }, [])

  return { notifyBrowserViewportResize, showResizeWarning }
}
