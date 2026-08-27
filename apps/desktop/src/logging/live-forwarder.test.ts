import { describe, expect, test } from 'bun:test'
import { createLogLiveForwarder } from './live-forwarder'
import type { LumeLogEventV2 } from '@lume/shared'

/** 假时钟：手动 tick 触发 coalesce 窗口到期。 */
function fakeClock() {
  let now = 0
  let timer: (() => void) | null = null
  return {
    now: () => now,
    schedule: (fn: () => void, _ms: number) => { timer = fn; return fn as unknown as ReturnType<typeof setTimeout> },
    cancel: () => { timer = null },
    tick: (ms: number) => { now += ms; timer?.(); timer = null },
    pending: () => timer !== null,
  }
}

function event(id: string): LumeLogEventV2 {
  return {
    schemaVersion: 2,
    eventId: id,
    observedAt: '2026-08-26T00:00:00.000Z',
    level: 'info',
    source: 'main',
    kind: 'log',
    context: 'test',
    event: 'log.message',
    message: `m-${id}`,
  } as LumeLogEventV2
}

function harness(overrides: Partial<Parameters<typeof createLogLiveForwarder>[0]> = {}) {
  const sent: unknown[] = []
  const clock = fakeClock()
  let alive = true
  const forwarder = createLogLiveForwarder({
    isAlive: () => alive,
    send: (payload) => { sent.push(payload) },
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...overrides,
  })
  return { forwarder, sent, clock, kill: () => { alive = false } }
}

describe('createLogLiveForwarder (#753)', () => {
  test('同窗口内多批合并为一次推送（coalesce）', () => {
    const { forwarder, sent, clock } = harness()
    forwarder.push([event('a1')])
    forwarder.push([event('a2')])
    forwarder.push([event('a3')])
    expect(sent).toEqual([])
    clock.tick(100)
    expect(sent).toHaveLength(1)
    const payload = sent[0] as { events: LumeLogEventV2[] }
    expect(payload.events.map((e) => e.eventId)).toEqual(['a1', 'a2', 'a3'])
  })

  test('积压超过上限丢新事件并在推送中携带 dropped 计数', () => {
    const { forwarder, sent, clock } = harness()
    for (let i = 0; i < 210; i++) forwarder.push([event(`e${i}`)])
    clock.tick(100)
    expect(sent).toHaveLength(1)
    const payload = sent[0] as { events: LumeLogEventV2[]; dropped: number }
    expect(payload.events).toHaveLength(200)
    expect(payload.dropped).toBe(10)
  })

  test('目标失活立即停推且不再调度', () => {
    const { forwarder, sent, clock, kill } = harness()
    forwarder.push([event('x')])
    kill()
    clock.tick(100)
    expect(sent).toEqual([])
    expect(clock.pending()).toBe(false)
  })

  test('dispose 取消未决窗口', () => {
    const { forwarder, sent, clock } = harness()
    forwarder.push([event('x')])
    forwarder.dispose()
    expect(clock.pending()).toBe(false)
    clock.tick(100)
    expect(sent).toEqual([])
  })
})
