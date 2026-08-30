// 驻留协调器(BrowserTabResidencyCoordinator)移植测试。
// 覆盖:保护位判定、suspend-pending 取消(generation+1)、restoring 完成/失败路径、
// markAttached 代数校验、LRU 淘汰受害者选择与保护跳过、onEvict 返回 false 时淘汰循环终止。
import { describe, expect, test } from 'bun:test'
import {
  BrowserTabResidencyCoordinator,
  TAB_LIMIT,
  isResidencyProtected,
  selectEvictionVictim,
  type BrowserTabResidencyCoordinatorOptions,
  type ResidencyRecord,
} from '../residency'

let recordSeq = 0

function makeRecord(overrides: Partial<ResidencyRecord> = {}): ResidencyRecord {
  recordSeq += 1
  return {
    tabId: `tab-${recordSeq}`,
    windowId: 1,
    sessionId: 's1',
    residency: 'live-background',
    generation: 0,
    openedAt: 1_000,
    lastActivityAt: 1_000,
    ...overrides,
  }
}

function makeCoordinator(overrides: Partial<BrowserTabResidencyCoordinatorOptions> = {}) {
  return new BrowserTabResidencyCoordinator({ onEvict: () => true, ...overrides })
}

describe('isResidencyProtected', () => {
  test('每个活动位为 true 即受保护', () => {
    const flagCases: Array<Partial<ResidencyRecord>> = [
      { selected: true },
      { visible: true },
      { operationActive: true },
      { captureActive: true },
      { audible: true },
      { mediaActive: true },
      { loading: true },
      { downloadActive: true },
    ]
    for (const patch of flagCases) {
      expect(isResidencyProtected(makeRecord(patch))).toBe(true)
    }
  })

  test('live-visible/restoring/suspend-pending 即受保护', () => {
    for (const residency of ['live-visible', 'restoring', 'suspend-pending'] as const) {
      expect(isResidencyProtected(makeRecord({ residency }))).toBe(true)
    }
  })

  test('suspended/live-background 且无活动位 → 不受保护', () => {
    expect(isResidencyProtected(makeRecord({ residency: 'suspended' }))).toBe(false)
    expect(isResidencyProtected(makeRecord({ residency: 'live-background' }))).toBe(false)
  })
})

describe('suspend-pending 取消(report 救活)', () => {
  test('visible 救活 → generation+1 回 live-visible', () => {
    const coordinator = makeCoordinator()
    // 首次 upsert generation 归 0;rescue 后 +1
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspend-pending', visible: false }))
    coordinator.report('t1', { visible: true })
    const after = coordinator.get('t1')
    expect(after?.generation).toBe(1)
    expect(after?.residency).toBe('live-visible')
  })

  test('后台活动位(loading)救活 → generation+1 回 live-background', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspend-pending', visible: false }))
    coordinator.report('t1', { loading: true })
    const after = coordinator.get('t1')
    expect(after?.generation).toBe(1)
    expect(after?.residency).toBe('live-background')
  })

  test('空补丁/纯 false 补丁不取消挂起', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspend-pending', visible: false }))
    coordinator.report('t1', {})
    coordinator.report('t1', { loading: false })
    const after = coordinator.get('t1')
    expect(after?.generation).toBe(0)
    expect(after?.residency).toBe('suspend-pending')
  })

  test('非 suspend-pending 记录按 visible 归位 live-*', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspended', visible: false }))
    coordinator.report('t1', {})
    expect(coordinator.get('t1')?.residency).toBe('suspended') // suspended 不在归位集合
    coordinator.upsert(makeRecord({ tabId: 't2', residency: 'live-background', visible: false }))
    coordinator.report('t2', { visible: true })
    expect(coordinator.get('t2')?.residency).toBe('live-visible')
    coordinator.report('t2', { visible: false })
    expect(coordinator.get('t2')?.residency).toBe('live-background')
  })
})

describe('report(selected) 唯一化 preferred', () => {
  test('同窗口同会话其它记录 preferred=false,本记录记 lastSelectedAt', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 'a', preferred: true }))
    coordinator.upsert(makeRecord({ tabId: 'b', preferred: true, windowId: 1, sessionId: 'other' }))
    coordinator.upsert(makeRecord({ tabId: 'c', preferred: true, windowId: 2 }))
    coordinator.upsert(makeRecord({ tabId: 'd', preferred: true })) // 与 a 同窗口同会话
    coordinator.report('a', { selected: true })
    expect(coordinator.get('a')?.preferred).toBe(true)
    expect(coordinator.get('a')?.lastSelectedAt).toBeGreaterThan(0)
    expect(coordinator.get('b')?.preferred).toBe(true) // 不同 sessionId 不清
    expect(coordinator.get('c')?.preferred).toBe(true) // 不同 windowId 不清
    expect(coordinator.get('d')?.preferred).toBe(false) // 同窗口同会话被清
    coordinator.report('b', { selected: true })
    expect(coordinator.get('a')?.preferred).toBe(true) // 跨会话不清 a
    expect(coordinator.get('b')?.preferred).toBe(true)
  })
})

describe('restoring 完成/失败路径', () => {
  test('markRestoring 仅从 suspended 进入,否则 no-op', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 'live', residency: 'live-background' }))
    const untouched = coordinator.markRestoring('live')
    expect(untouched?.residency).toBe('live-background')
    expect(untouched?.generation).toBe(0)
    expect(coordinator.markRestoring('missing')).toBeNull()

    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspended' }))
    const restoring = coordinator.markRestoring('t1')
    expect(restoring?.residency).toBe('restoring')
    expect(restoring?.generation).toBe(1)
    expect(restoring?.loading).toBe(true)
  })

  test('completeRestore:代数匹配才成功,按 visible 归位', () => {
    const coordinator = makeCoordinator({ now: () => 5_000 })
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspended', visible: false }))
    coordinator.markRestoring('t1') // generation 1
    expect(coordinator.completeRestore('t1', 0)).toBe(false)
    expect(coordinator.get('t1')?.residency).toBe('restoring')
    expect(coordinator.completeRestore('t1', 1)).toBe(true)
    expect(coordinator.get('t1')?.residency).toBe('live-background')
    expect(coordinator.get('t1')?.loading).toBe(false)
    expect(coordinator.get('t1')?.lastActivityAt).toBe(5_000)
  })

  test('failRestore:回 suspended 且 generation+1;代数/状态不符返回 null', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspended' }))
    coordinator.markRestoring('t1') // generation 1
    expect(coordinator.failRestore('t1', 999)).toBeNull()
    const failed = coordinator.failRestore('t1', 1)
    expect(failed?.residency).toBe('suspended')
    expect(failed?.generation).toBe(2)
    expect(failed?.loading).toBe(false)
    expect(coordinator.failRestore('t1', 2)).toBeNull() // 已非 restoring
  })
})

describe('commitCancelledSuspend', () => {
  test('generation 已推进时直接落 suspended;否则拒绝', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspend-pending', visible: false }))
    expect(coordinator.commitCancelledSuspend('t1', 0)).toBeNull() // generation 未推进

    coordinator.report('t1', { loading: true }) // 救活 → live-background,generation 1
    const committed = coordinator.commitCancelledSuspend('t1', 0)
    expect(committed?.residency).toBe('suspended')
    expect(committed?.generation).toBe(1)
  })
})

describe('markAttached 代数校验', () => {
  test('restoring 态下代数不匹配/缺失 → 拒绝且 residency 不动', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspended' }))
    coordinator.markRestoring('t1') // generation 1,restoring
    expect(coordinator.markAttached('t1', true, 0)).toBe(false)
    expect(coordinator.markAttached('t1', true)).toBe(false)
    const after = coordinator.get('t1')
    expect(after?.residency).toBe('restoring')
  })

  test('restoring 态下代数匹配 → 接受,保持 restoring 待 complete/fail', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspended' }))
    coordinator.markRestoring('t1')
    expect(coordinator.markAttached('t1', true, 1)).toBe(true)
    expect(coordinator.get('t1')?.residency).toBe('restoring')
    expect(coordinator.get('t1')?.visible).toBe(true)
    expect(coordinator.completeRestore('t1', 1)).toBe(true)
    expect(coordinator.get('t1')?.residency).toBe('live-visible')
  })

  test('非 restoring 态 attach → 按 visible 归位 live-*', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspended' }))
    expect(coordinator.markAttached('t1', false)).toBe(true)
    expect(coordinator.get('t1')?.residency).toBe('live-background')
    expect(coordinator.get('t1')?.guestAttached).toBe(true)
    expect(coordinator.markAttached('missing', true)).toBe(false)
  })
})

describe('isTransitionCurrent / markDetached / upsert 代数保留', () => {
  test('generation + 期望状态都匹配才有效', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', residency: 'suspended' }))
    coordinator.markRestoring('t1')
    expect(coordinator.isTransitionCurrent('t1', 1, 'restoring')).toBe(true)
    expect(coordinator.isTransitionCurrent('t1', 0, 'restoring')).toBe(false)
    expect(coordinator.isTransitionCurrent('t1', 1, 'suspended')).toBe(false)
    expect(coordinator.isTransitionCurrent('missing', 0, 'suspended')).toBe(false)
  })

  test('markDetached 清 guestAttached;重复 upsert 保留已有 generation', () => {
    const coordinator = makeCoordinator()
    coordinator.upsert(makeRecord({ tabId: 't1', guestAttached: true }))
    coordinator.markDetached('t1')
    expect(coordinator.get('t1')?.guestAttached).toBe(false)

    const again = coordinator.upsert(makeRecord({ tabId: 't1', visible: true }))
    expect(again.generation).toBe(0) // 首次 upsert generation 归 0,重复 upsert 保留
    coordinator.markRestoring('t1') // live-background → no-op,generation 仍 0
    coordinator.report('t1', { loading: true })
    expect(coordinator.get('t1')?.generation).toBe(0) // 非 suspend-pending,generation 不变
  })
})

describe('淘汰裁决', () => {
  test('selectEvictionVictim:LRU 三级比较 + tabId 决胜', () => {
    const lastActivityWins = selectEvictionVictim(
      [
        makeRecord({ tabId: 'a', lastActivityAt: 100, openedAt: 1 }),
        makeRecord({ tabId: 'b', lastActivityAt: 100, openedAt: 2 }),
        makeRecord({ tabId: 'c', lastActivityAt: 300 }),
      ],
      { windowId: 1, tabLimit: 2 },
    )
    expect(lastActivityWins?.tabId).toBe('a')

    const lastSelectedWins = selectEvictionVictim(
      [
        makeRecord({ tabId: 'a', lastActivityAt: 100, lastSelectedAt: 50 }),
        makeRecord({ tabId: 'b', lastActivityAt: 100 }),
        makeRecord({ tabId: 'c', lastActivityAt: 100, lastSelectedAt: 10 }),
      ],
      { windowId: 1, tabLimit: 2 },
    )
    expect(lastSelectedWins?.tabId).toBe('b') // 无 lastSelectedAt 视为 -Infinity

    const openedAtWins = selectEvictionVictim(
      [
        makeRecord({ tabId: 'z', lastActivityAt: 100, lastSelectedAt: 5, openedAt: 9 }),
        makeRecord({ tabId: 'a', lastActivityAt: 100, lastSelectedAt: 5, openedAt: 2 }),
      ],
      { windowId: 1, tabLimit: 1 },
    )
    expect(openedAtWins?.tabId).toBe('a')

    const tabIdWins = selectEvictionVictim(
      [
        makeRecord({ tabId: 'z', lastActivityAt: 100, lastSelectedAt: 5, openedAt: 1 }),
        makeRecord({ tabId: 'a', lastActivityAt: 100, lastSelectedAt: 5, openedAt: 1 }),
      ],
      { windowId: 1, tabLimit: 1 },
    )
    expect(tabIdWins?.tabId).toBe('a')
  })

  test('不超限返回 null;全被保护返回 null;其它窗口不计入上限', () => {
    const single = [makeRecord({ tabId: 'a', residency: 'suspended' })]
    expect(selectEvictionVictim(single, { windowId: 1, tabLimit: TAB_LIMIT })).toBeNull()
    expect(selectEvictionVictim(single, { windowId: 1, tabLimit: 1 })).toBeNull() // <= limit

    const allProtected = [
      makeRecord({ tabId: 'a', visible: true }),
      makeRecord({ tabId: 'b', loading: true }),
      makeRecord({ tabId: 'c', residency: 'live-visible' }),
    ]
    expect(selectEvictionVictim(allProtected, { windowId: 1, tabLimit: 2 })).toBeNull()

    const crossWindow = [
      makeRecord({ tabId: 'w2-a', windowId: 2 }),
      makeRecord({ tabId: 'w2-b', windowId: 2 }),
      makeRecord({ tabId: 'w1-a', windowId: 1, residency: 'suspended' }),
    ]
    expect(selectEvictionVictim(crossWindow, { windowId: 1, tabLimit: 2 })).toBeNull()
    expect(selectEvictionVictim(crossWindow, { windowId: 2, tabLimit: 1 })?.tabId).toBe('w2-a')
  })

  test('协调器淘汰:跳过保护记录,选 LRU 受害者并移除', async () => {
    const evicted: string[] = []
    const coordinator = makeCoordinator({
      tabLimit: 2,
      onEvict: (record) => {
        evicted.push(record.tabId)
        return true
      },
    })
    coordinator.upsert(makeRecord({ tabId: 'mid', residency: 'suspended', lastActivityAt: 2 }))
    coordinator.upsert(makeRecord({ tabId: 'protected', residency: 'live-visible', lastActivityAt: 0 }))
    coordinator.upsert(makeRecord({ tabId: 'oldest', residency: 'suspended', lastActivityAt: 1 }))
    coordinator.upsert(makeRecord({ tabId: 'newest', residency: 'suspended', lastActivityAt: 3, windowId: 9 }))
    await coordinator.whenIdle()
    expect(evicted).toEqual(['oldest'])
    expect(coordinator.get('oldest')).toBeNull()
    expect(coordinator.get('mid')).not.toBeNull()
    expect(coordinator.get('protected')).not.toBeNull()
    expect(coordinator.get('newest')).not.toBeNull()
  })

  test('onEvict 返回 false → 内层淘汰循环立即停止,记录保留', async () => {
    let calls = 0
    const coordinator = makeCoordinator({
      tabLimit: 1,
      onEvict: async () => {
        calls += 1
        return false
      },
    })
    coordinator.upsert(makeRecord({ tabId: 'a', residency: 'suspended', lastActivityAt: 5 }))
    coordinator.upsert(makeRecord({ tabId: 'b', residency: 'suspended', lastActivityAt: 4 }))
    coordinator.upsert(makeRecord({ tabId: 'c', residency: 'suspended', lastActivityAt: 3 }))
    await coordinator.whenIdle()
    expect(calls).toBe(1) // 首个受害者即失败,不再继续淘汰
    expect(coordinator.get('a')).not.toBeNull()
    expect(coordinator.get('b')).not.toBeNull()
    expect(coordinator.get('c')).not.toBeNull()
  })

  test('onEvict 先成功后失败 → 部分淘汰后停止(remove 会重新入队窗口,符合 ZCode 语义)', async () => {
    const calls: string[] = []
    const coordinator = makeCoordinator({
      tabLimit: 1,
      onEvict: (record) => {
        calls.push(record.tabId)
        return record.tabId === 'oldest'
      },
    })
    coordinator.upsert(makeRecord({ tabId: 'oldest', residency: 'suspended', lastActivityAt: 1 }))
    coordinator.upsert(makeRecord({ tabId: 'middle', residency: 'suspended', lastActivityAt: 2 }))
    coordinator.upsert(makeRecord({ tabId: 'newest', residency: 'suspended', lastActivityAt: 3 }))
    await coordinator.whenIdle()
    // oldest 淘汰成功 → remove 重新入队 → middle 再次被选中且淘汰失败 → 停止
    expect(calls).toEqual(['oldest', 'middle', 'middle'])
    expect(coordinator.get('oldest')).toBeNull()
    expect(coordinator.get('middle')).not.toBeNull()
    expect(coordinator.get('newest')).not.toBeNull()
  })

  test('dispose 后不再裁决;remove/whenIdle 正常收尾', async () => {
    let evictions = 0
    const coordinator = makeCoordinator({
      tabLimit: 1,
      onEvict: () => {
        evictions += 1
        return true
      },
    })
    coordinator.upsert(makeRecord({ tabId: 'a', residency: 'suspended' }))
    coordinator.remove('a')
    await coordinator.whenIdle()
    expect(coordinator.get('a')).toBeNull()
    expect(coordinator.list()).toHaveLength(0)

    coordinator.dispose()
    coordinator.upsert(makeRecord({ tabId: 'b1', residency: 'suspended', lastActivityAt: 1 }))
    coordinator.upsert(makeRecord({ tabId: 'b2', residency: 'suspended', lastActivityAt: 2 }))
    await coordinator.whenIdle()
    expect(evictions).toBe(0) // disposed,requestEvaluation 直接返回
  })
})
