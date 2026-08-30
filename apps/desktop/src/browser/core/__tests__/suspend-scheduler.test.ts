// 空闲挂起调度器测试:纯裁决(空闲判定/保护跳过/已挂起跳过/isProtected)+ tick 驱动
// (窗口守卫、逐候选发起、失败不阻断后续、重入保护)。
import { describe, expect, test } from 'bun:test'
import type { BrowserGuestManager, TabSuspendView } from '../guest-manager'
import { createSuspendScheduler, selectIdleSuspendCandidates, type SuspendSchedulerOptions } from '../suspend-scheduler'

const NOW = 1_000_000_000
const IDLE_DELAY = 5 * 60 * 1000

function makeView(overrides: Partial<TabSuspendView> = {}): TabSuspendView {
  return {
    tabId: 'tab-1',
    residency: 'live-background',
    visible: false,
    busy: false,
    lastActivityAt: NOW - IDLE_DELAY - 1,
    ...overrides,
  }
}

describe('selectIdleSuspendCandidates(纯裁决)', () => {
  const options = { idleDelayMs: IDLE_DELAY, now: NOW }

  test('空闲超阈值的 live-background 候选被选中,保持输入顺序', () => {
    const views = [
      makeView({ tabId: 'b' }),
      makeView({ tabId: 'a', lastActivityAt: NOW - 10 }),
      makeView({ tabId: 'c', lastActivityAt: NOW - IDLE_DELAY }),
    ]
    expect(selectIdleSuspendCandidates(views, options)).toEqual(['b', 'c'])
  })

  test('空闲判定:未达阈值/恰好等于阈值', () => {
    expect(selectIdleSuspendCandidates([makeView({ lastActivityAt: NOW - IDLE_DELAY + 1 })], options)).toEqual([])
    expect(selectIdleSuspendCandidates([makeView({ lastActivityAt: NOW - IDLE_DELAY })], options)).toEqual(['tab-1'])
  })

  test('非 live-background 一律跳过(已挂起/挂起中/恢复中/可见)', () => {
    for (const residency of ['suspended', 'suspend-pending', 'restoring', 'live-visible'] as const) {
      expect(selectIdleSuspendCandidates([makeView({ residency })], options)).toEqual([])
    }
  })

  test('visible=true 跳过', () => {
    expect(selectIdleSuspendCandidates([makeView({ visible: true })], options)).toEqual([])
  })

  test('busy=true 跳过(agent 命令/下载/媒体等运行态保护)', () => {
    expect(selectIdleSuspendCandidates([makeView({ busy: true })], options)).toEqual([])
  })

  test('isProtected 注入谓词命中即跳过', () => {
    const views = [makeView({ tabId: 'keep' }), makeView({ tabId: 'drop' })]
    const picked = selectIdleSuspendCandidates(views, {
      ...options,
      isProtected: view => view.tabId === 'keep',
    })
    expect(picked).toEqual(['drop'])
  })
})

describe('createSuspendScheduler(tick 驱动)', () => {
  function makeManager(views: TabSuspendView[], suspendCalls: string[], failTabIds: string[] = []): BrowserGuestManager {
    return {
      listSuspendViews: () => views,
      suspendTabForIdle: async (tabId: string) => {
        suspendCalls.push(tabId)
        if (failTabIds.includes(tabId)) throw new Error('suspend flight failed')
        return true
      },
    } as unknown as BrowserGuestManager
  }

  function makeOptions(manager: BrowserGuestManager, overrides: Partial<SuspendSchedulerOptions> = {}): SuspendSchedulerOptions {
    return {
      manager,
      getWindow: () => ({ isDestroyed: () => false }) as unknown as import('electron').BrowserWindow,
      warn: () => {},
      ...overrides,
    }
  }

  test('tick 选出候选并逐个发起挂起', async () => {
    const calls: string[] = []
    const scheduler = createSuspendScheduler(makeOptions(
      makeManager([makeView({ tabId: 'x' }), makeView({ tabId: 'y', visible: true })], calls),
    ))
    expect(await scheduler.tick()).toEqual(['x'])
    expect(calls).toEqual(['x'])
  })

  test('单个发起失败不阻断其余候选,且经 warn 上报', async () => {
    const calls: string[] = []
    const warnings: string[] = []
    const scheduler = createSuspendScheduler(makeOptions(
      makeManager([makeView({ tabId: 'bad' }), makeView({ tabId: 'good' })], calls, ['bad']),
      { warn: (message) => warnings.push(message) },
    ))
    expect(await scheduler.tick()).toEqual(['bad', 'good'])
    expect(calls).toEqual(['bad', 'good'])
    expect(warnings).toHaveLength(1)
  })

  test('窗口缺失/已销毁时 tick 空转', async () => {
    const calls: string[] = []
    const scheduler = createSuspendScheduler(makeOptions(
      makeManager([makeView()], calls),
      { getWindow: () => ({ isDestroyed: () => true }) as unknown as import('electron').BrowserWindow },
    ))
    expect(await scheduler.tick()).toEqual([])
    expect(calls).toEqual([])
  })

  test('tick 重入保护:进行中的轮次直接跳过', async () => {
    const calls: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const manager = {
      listSuspendViews: () => [makeView()],
      suspendTabForIdle: async (tabId: string) => {
        calls.push(tabId)
        await gate
        return true
      },
    } as unknown as BrowserGuestManager
    const scheduler = createSuspendScheduler(makeOptions(manager))
    const first = scheduler.tick()
    expect(await scheduler.tick()).toEqual([])
    release?.()
    expect(await first).toEqual(['tab-1'])
  })

  test('start/stop:stop 后不再轮询(start 幂等)', () => {
    const calls: string[] = []
    const scheduler = createSuspendScheduler(makeOptions(makeManager([], calls), { pollIntervalMs: 5 }))
    scheduler.start()
    scheduler.start()
    scheduler.stop()
    scheduler.stop()
  })
})
