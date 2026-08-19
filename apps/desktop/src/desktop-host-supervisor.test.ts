import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createDesktopHostSupervisor } from './desktop-host-supervisor'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4321
  kill() { return true }
}

function createHarness() {
  const children: FakeChildProcess[] = []
  const timers: Array<() => void> = []
  let clock = 1_000_000
  const supervisor = createDesktopHostSupervisor({
    binaryPath: 'desktop-host.bin',
    platform: 'win32',
    exists: () => true,
    spawn: (() => {
      const child = new FakeChildProcess()
      children.push(child)
      return child as unknown as ChildProcess
    }) as typeof import('node:child_process').spawn,
    id: () => 'fixed-id',
    token: () => 'session-token',
    schedule: (callback) => {
      timers.push(callback)
      return {} as ReturnType<typeof setTimeout>
    },
    cancelSchedule: () => undefined,
    now: () => clock,
  })
  return {
    supervisor,
    children,
    timers,
    advance: (ms: number) => { clock += ms },
    flushRestart: () => { timers.shift()?.() },
  }
}

describe('createDesktopHostSupervisor', () => {
  test('spawn 失败(仅 error 事件)降级 state 并按退避调度重启', async () => {
    const h = createHarness()
    await h.supervisor.start()
    expect(h.supervisor.getState()?.available).toBe(true)
    h.children[0]!.emit('error', new Error('EACCES'))
    const state = h.supervisor.getState()
    const reason = state?.available === false ? state.reason : ''
    expect(state?.available).toBe(false)
    expect(reason).toContain('EACCES')
    expect(h.timers).toHaveLength(1)
  })

  test('spawn 即崩的循环在 3 次后熔断,不再重启', async () => {
    const h = createHarness()
    await h.supervisor.start()
    for (let round = 0; round < 3; round++) {
      const child = h.children[round]!
      child.emit('spawn')
      child.emit('exit', 1)
      h.flushRestart()
    }
    expect(h.timers).toHaveLength(0)
    expect(h.supervisor.getState()?.available).toBe(false)
  })

  test('稳定运行超过 10s 后崩溃,窗口清零不熔断', async () => {
    const h = createHarness()
    await h.supervisor.start()
    h.children[0]!.emit('spawn')
    h.children[0]!.emit('exit', 1)
    h.flushRestart()
    h.advance(11_000)
    h.children[1]!.emit('spawn')
    h.advance(11_000)
    h.children[1]!.emit('exit', 1)
    expect(h.timers).toHaveLength(1)
  })
})
