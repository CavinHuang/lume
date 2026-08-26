import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createDesktopHostSupervisor } from './desktop-host-supervisor'
import type { LumeHostLogLine } from '@lume/shared'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4321
  kill() { return true }
}

function createHarness() {
  const children: FakeChildProcess[] = []
  const timers: Array<() => void> = []
  const logs: string[] = []
  const events: LumeHostLogLine[] = []
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
    log: (message) => { logs.push(message) },
    logEvent: (event) => { events.push(event) },
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
    logs,
    events,
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

  test('stderr 的 LUMELOG 行解析为结构化事件并路由到 logEvent', async () => {
    const h = createHarness()
    await h.supervisor.start()
    h.children[0]!.stderr.emit('data', Buffer.from('LUMELOG {"level":"warn","context":"host.pipe","event":"pipe.error","message":"boom"}\n'))
    expect(h.events).toEqual([
      { level: 'warn', context: 'host.pipe', event: 'pipe.error', message: 'boom' },
    ])
    expect(h.logs).toEqual([])
  })

  test('普通 stderr 文本行仍走 log 路径并带 [desktop-host] 前缀', async () => {
    const h = createHarness()
    await h.supervisor.start()
    h.children[0]!.stderr.emit('data', Buffer.from('plain text\n'))
    expect(h.logs).toEqual(['[desktop-host] plain text'])
    expect(h.events).toEqual([])
  })

  test('跨 chunk 分裂的 LUMELOG 行经缓冲后只解析出一条事件', async () => {
    const h = createHarness()
    await h.supervisor.start()
    h.children[0]!.stdout.emit('data', Buffer.from('LUMELOG {"level":"info","context":"c",'))
    h.children[0]!.stdout.emit('data', Buffer.from('"event":"e","message":"m"}\nplain after\n'))
    expect(h.events).toEqual([
      { level: 'info', context: 'c', event: 'e', message: 'm' },
    ])
    expect(h.logs).toEqual(['[desktop-host] plain after'])
  })

  test('非对象的 LUMELOG 载荷（null/数组）回退文本路径而不抛异常', async () => {
    const h = createHarness()
    await h.supervisor.start()
    // JSON.parse("null") 返回 null——解构会在 data handler 里抛未捕获异常击穿主进程。
    h.children[0]!.stderr.emit('data', Buffer.from('LUMELOG null\nLUMELOG [1,2]\n'))
    expect(h.events).toEqual([])
    expect(h.logs).toEqual(['[desktop-host] LUMELOG null', '[desktop-host] LUMELOG [1,2]'])
  })
})
