/**
 * 运行时事件批量 flush 调度器(#676)。
 *
 * 单靠 requestAnimationFrame 调度在窗口最小化/被遮挡/后台时会被 Chromium 节流
 * 至暂停:运行时事件持续入队但 flush 永不执行,流式 UI 冻结在旧快照,直到重新
 * 前台化才一次性补齐。这里让 rAF 与低频 setTimeout 回退竞速:
 * - 前台:rAF(下一帧)恒先于回退触发,现有合并批效率不变;
 * - 后台:rAF 被节流时由回退兜底,积压事件仍在有限时间内批量交付;
 * - 任一先触发即取消另一方并清空挂起状态(互斥),避免恢复前台后旧 rAF 回调
 *   对已消费批次重复 flush。
 */
export interface RuntimeEventFlushScheduler {
  /** 事件入队后调用;已有挂起调度时为幂等 no-op(继续攒同一批)。 */
  schedule(): void
  /** 取消全部挂起调度(effect cleanup / 卸载前调用)。 */
  cancelPending(): void
}

const FALLBACK_FLUSH_MS = 500

export interface RuntimeEventFlushSchedulerOptions {
  fallbackDelayMs?: number
  requestRaf?: (callback: () => void) => number
  cancelRaf?: (id: number) => void
}

export function createRuntimeEventFlushScheduler(
  flush: () => void,
  options: RuntimeEventFlushSchedulerOptions = {},
): RuntimeEventFlushScheduler {
  const fallbackDelayMs = options.fallbackDelayMs ?? FALLBACK_FLUSH_MS
  const requestRaf = options.requestRaf ?? ((callback: () => void) => requestAnimationFrame(callback))
  const cancelRaf = options.cancelRaf ?? ((id: number) => cancelAnimationFrame(id))

  let rafId: number | null = null
  let timerId: ReturnType<typeof setTimeout> | null = null

  const cancelPending = (): void => {
    if (rafId !== null) {
      cancelRaf(rafId)
      rafId = null
    }
    if (timerId !== null) {
      clearTimeout(timerId)
      timerId = null
    }
  }

  const runFlush = (): void => {
    // 竞速互斥:rAF 与回退任一先到即取消另一方
    cancelPending()
    flush()
  }

  return {
    schedule(): void {
      if (rafId !== null || timerId !== null) return
      rafId = requestRaf(runFlush)
      timerId = setTimeout(runFlush, fallbackDelayMs)
    },
    cancelPending,
  }
}
