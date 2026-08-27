/**
 * live 日志推送的合流与背压闸（#753）。
 *
 * service 每次落盘 flush 都会逐订阅者回调；此处把「每批必发」收敛为
 * 「窗口内合并、超限丢新」，防 dev trace 洪峰打爆 webContents.send。
 */
import type { LumeLogEventV2 } from '@lume/shared'

/** 合流窗口：多次 flush 在窗口内合并为一次 IPC 推送。 */
export const LIVE_COALESCE_MS = 100
/** 单次推送携带的事件上限：超过部分丢新（live 是观感通道，旧事件价值高于新事件）。 */
export const LIVE_MAX_EVENTS_PER_PUSH = 200

export interface LogLiveForwarder {
  push(events: LumeLogEventV2[]): void
  dispose(): void
}

export function createLogLiveForwarder(deps: {
  isAlive: () => boolean
  send: (payload: { events: LumeLogEventV2[]; dropped?: number }) => void
  now?: () => number
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
}): LogLiveForwarder {
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle))
  let pending: LumeLogEventV2[] = []
  let dropped = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let windowStartedAt = 0

  const flush = (): void => {
    timer = null
    if (!deps.isAlive() || pending.length === 0) {
      pending = []
      dropped = 0
      return
    }
    const overflow = pending.length - LIVE_MAX_EVENTS_PER_PUSH
    if (overflow > 0) {
      // 丢新：live 跟随视图关注尾部，截掉越界新事件并如实上报丢弃数。
      pending = pending.slice(0, LIVE_MAX_EVENTS_PER_PUSH)
      dropped += overflow
    }
    const payload = dropped > 0
      ? { events: pending, dropped }
      : { events: pending }
    pending = []
    dropped = 0
    deps.send(payload)
  }

  return {
    push(events) {
      if (!deps.isAlive() || events.length === 0) return
      if (!timer) {
        windowStartedAt = now()
        timer = schedule(flush, LIVE_COALESCE_MS)
      }
      pending.push(...events)
      // 窗口内已积压超限即早丢，避免洪峰期 pending 无界增长（ponytail: 定长截断，够用）。
      if (pending.length > LIVE_MAX_EVENTS_PER_PUSH) {
        const overflow = pending.length - LIVE_MAX_EVENTS_PER_PUSH
        pending = pending.slice(0, LIVE_MAX_EVENTS_PER_PUSH)
        dropped += overflow
      }
    },
    dispose() {
      if (timer) cancel(timer)
      timer = null
      pending = []
      dropped = 0
    },
  }
}
