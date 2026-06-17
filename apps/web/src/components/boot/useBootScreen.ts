import { useEffect, useRef, useState } from 'react'
import {
  BOOT_TIMINGS,
  resolveBootPhase,
  shouldShowHint,
  type LumeBootPhase,
} from './boot-phase'

export interface UseBootScreenOptions {
  /** 后端是否就绪。为 true 时进入「就绪」并触发淡出退出。 */
  ready: boolean
  /** 受控阶段覆盖；提供时跳过 ready 驱动序列（未来真实启动阶段接入点）。 */
  scene?: LumeBootPhase
  /** 淡出完成后回调（App 据此渲染主界面）。 */
  onExited?: () => void
}

export interface BootScreenState {
  phase: LumeBootPhase
  fading: boolean
  showHint: boolean
}

/**
 * 启动页驱动：
 * - 等待后端期间按计时推进 唤醒→整理→记忆（记忆循环）。
 * - ready 为真时立即进入「就绪」，停留 readyHoldMs，淡出 fadeMs，再回调 onExited。
 * - scene 受控时直接显示该阶段。
 */
export function useBootScreen({ ready, scene, onExited }: UseBootScreenOptions): BootScreenState {
  const [phase, setPhase] = useState<LumeBootPhase>('awaken')
  const [fading, setFading] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const startRef = useRef<number | null>(null)
  const exitStartedRef = useRef(false)
  const onExitedRef = useRef(onExited)
  onExitedRef.current = onExited

  // 等待期间：计时推进阶段 + 慢启动提示。
  useEffect(() => {
    if (scene !== undefined || ready) return
    if (startRef.current === null) startRef.current = performance.now()
    let raf = requestAnimationFrame(function tick() {
      const elapsed = performance.now() - (startRef.current ?? 0)
      setPhase(resolveBootPhase(false, elapsed))
      setShowHint(shouldShowHint(false, elapsed))
      raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [ready, scene])

  // ready：进入就绪 → 停留 → 淡出 → 退出。
  useEffect(() => {
    if (scene !== undefined || !ready || exitStartedRef.current) return
    exitStartedRef.current = true
    setPhase('ready')
    setShowHint(false)
    const fadeTimer = window.setTimeout(() => setFading(true), BOOT_TIMINGS.readyHoldMs)
    const exitTimer = window.setTimeout(
      () => onExitedRef.current?.(),
      BOOT_TIMINGS.readyHoldMs + BOOT_TIMINGS.fadeMs,
    )
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(exitTimer)
    }
  }, [ready, scene])

  // 受控覆盖。
  useEffect(() => {
    if (scene !== undefined) setPhase(scene)
  }, [scene])

  return { phase, fading, showHint }
}
