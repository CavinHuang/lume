import { describe, expect, test } from 'bun:test'
import { createRuntimeEventFlushScheduler } from './runtime-event-flush-scheduler'

/**
 * 手动触发的假 rAF:注册后永不自动触发回调(即模拟 Chromium 后台对 rAF 的
 * 节流/暂停),由测试显式 fireAll 或经 cancelPending 移除。
 */
function createFakeRaf() {
  const callbacks = new Map<number, () => void>()
  let nextId = 1
  return {
    requestRaf: (cb: () => void) => {
      const id = nextId
      nextId += 1
      callbacks.set(id, cb)
      return id
    },
    cancelRaf: (id: number) => {
      callbacks.delete(id)
    },
    fireAll: () => {
      const fired = [...callbacks.values()]
      callbacks.clear()
      for (const cb of fired) cb()
    },
    pendingCount: () => callbacks.size,
  }
}

describe('createRuntimeEventFlushScheduler', () => {
  test('前台:rAF 先触发 flush,并取消回退 timer(竞速互斥,flush 仅一次)', async () => {
    const fakeRaf = createFakeRaf()
    let flushCount = 0
    const scheduler = createRuntimeEventFlushScheduler(() => {
      flushCount += 1
    }, { fallbackDelayMs: 10, requestRaf: fakeRaf.requestRaf, cancelRaf: fakeRaf.cancelRaf })

    scheduler.schedule()
    expect(fakeRaf.pendingCount()).toBe(1)

    fakeRaf.fireAll()
    expect(flushCount).toBe(1)

    // rAF 已胜出:回退 timer 必须已被取消,否则到期后会二次 flush
    await Bun.sleep(30)
    expect(flushCount).toBe(1)
  })

  test('后台:rAF 被节流不触发时,回退 timer 在有限时间内兜底 flush', async () => {
    const fakeRaf = createFakeRaf() // 注册后永不 fire —— 模拟后台节流
    let flushCount = 0
    const scheduler = createRuntimeEventFlushScheduler(() => {
      flushCount += 1
    }, { fallbackDelayMs: 10, requestRaf: fakeRaf.requestRaf, cancelRaf: fakeRaf.cancelRaf })

    scheduler.schedule()

    await Bun.sleep(40)
    expect(flushCount).toBe(1)
    // timer 胜出后须连 rAF 一并取消:恢复前台后旧 rAF 回调不得再次 flush
    expect(fakeRaf.pendingCount()).toBe(0)

    fakeRaf.fireAll()
    expect(flushCount).toBe(1)
  })

  test('schedule 幂等:挂起期间重复入队只保留一组调度', async () => {
    const fakeRaf = createFakeRaf()
    let flushCount = 0
    const scheduler = createRuntimeEventFlushScheduler(() => {
      flushCount += 1
    }, { fallbackDelayMs: 10, requestRaf: fakeRaf.requestRaf, cancelRaf: fakeRaf.cancelRaf })

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()

    expect(fakeRaf.pendingCount()).toBe(1)
    fakeRaf.fireAll()
    await Bun.sleep(30)
    expect(flushCount).toBe(1)
  })

  test('cancelPending 取消双方:cleanup 后 rAF 与回退都不再触发', async () => {
    const fakeRaf = createFakeRaf()
    let flushCount = 0
    const scheduler = createRuntimeEventFlushScheduler(() => {
      flushCount += 1
    }, { fallbackDelayMs: 10, requestRaf: fakeRaf.requestRaf, cancelRaf: fakeRaf.cancelRaf })

    scheduler.schedule()
    scheduler.cancelPending()

    expect(fakeRaf.pendingCount()).toBe(0)
    fakeRaf.fireAll()
    await Bun.sleep(30)
    expect(flushCount).toBe(0)
  })

  test('无挂起调度时 cancelPending / fireAll 为安全 no-op', async () => {
    const fakeRaf = createFakeRaf()
    let flushCount = 0
    const scheduler = createRuntimeEventFlushScheduler(() => {
      flushCount += 1
    }, { fallbackDelayMs: 10, requestRaf: fakeRaf.requestRaf, cancelRaf: fakeRaf.cancelRaf })

    expect(() => scheduler.cancelPending()).not.toThrow()
    await Bun.sleep(30)
    expect(flushCount).toBe(0)
  })
})
