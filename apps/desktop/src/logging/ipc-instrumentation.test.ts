import { describe, expect, test } from 'bun:test'
import { instrumentIpcCommand, SLOW_IPC_MS, type IpcCommandEvent, type IpcInstrumentDeps } from './ipc-instrumentation'

function harness(quietNames: string[] = [], recordFailure?: IpcInstrumentDeps['recordFailure']) {
  const events: IpcCommandEvent[] = []
  const deps: IpcInstrumentDeps = {
    isQuiet: (name: string) => quietNames.includes(name),
    emit: (event) => { events.push(event) },
  }
  // 未显式注入时走模块级默认限流器（各用例命令名互异，首条必放行）。
  if (recordFailure) deps.recordFailure = recordFailure
  return { events, deps }
}

describe('instrumentIpcCommand', () => {
  test('成功路径发 debug 级 completed，含参数/结果摘要与关联 ID', async () => {
    const { events, deps } = harness()
    const result = await instrumentIpcCommand(deps, 'demo', { threadId: 'thread-1' }, () => ({ ok: 1 }))
    expect(result).toEqual({ ok: 1 })
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.level).toBe('debug')
    expect(e.event).toBe('command.completed')
    expect(e.durationMs).toBeTypeOf('number')
    expect(e.args).toEqual({ threadId: 'thread-1' })
    expect(e.correlation).toEqual({ threadId: 'thread-1' })
  })

  test('失败路径发 warn 级 failed 并原样 rethrow（含非 Error 抛出值）', async () => {
    const { events, deps } = harness()
    let caught: string | undefined
    await instrumentIpcCommand(deps, 'boom', {}, () => {
      throw new Error('kaboom')
    }).catch((error: Error) => { caught = error.message })
    expect(caught).toBe('kaboom')
    expect(events).toHaveLength(1)
    expect(events[0]!.level).toBe('warn')
    expect(events[0]!.event).toBe('command.failed')
    expect((events[0]!.error as Error)?.message).toBe('kaboom')

    const thrown: unknown[] = []
    await instrumentIpcCommand(deps, 'boom2', {}, () => Promise.reject('plain-string')).catch((e) => thrown.push(e))
    expect(thrown).toEqual(['plain-string'])
    // 非 Error 抛出值归一化后仍留详情，不再整体丢失。
    expect(events[1]!.error).toBe('plain-string')
  })

  test('failed 埋点限流：未放行时不 emit 但照常 rethrow', async () => {
    const { events, deps } = harness([], () => ({ allowed: false, suppressedCount: 3 }))
    let caught = false
    await instrumentIpcCommand(deps, 'spam', {}, () => {
      throw new Error('x')
    }).catch(() => { caught = true })
    expect(caught).toBe(true)
    expect(events).toHaveLength(0)
  })

  test('failed 埋点放行时透传 suppressedCount；为 0 不带该字段', async () => {
    const { events, deps } = harness([], () => ({ allowed: true, suppressedCount: 7 }))
    await instrumentIpcCommand(deps, 'a', {}, () => { throw new Error('x') }).catch(() => {})
    expect(events[0]!.suppressedCount).toBe(7)

    const { events: events2, deps: deps2 } = harness()
    await instrumentIpcCommand(deps2, 'b', {}, () => { throw new Error('y') }).catch(() => {})
    expect(events2[0]!.suppressedCount).toBeUndefined()
  })

  test('默认限流器：同名命令窗口内只发第一条 failed', async () => {
    const { events, deps } = harness()
    for (let i = 0; i < 3; i++) {
      await instrumentIpcCommand(deps, 'rate_limit_probe', {}, () => { throw new Error('flood') }).catch(() => {})
    }
    expect(events).toHaveLength(1)
  })

  test('quiet 命令豁免成功路径的日志', async () => {
    const { events, deps } = harness(['quiet_cmd'])
    const result = await instrumentIpcCommand(deps, 'quiet_cmd', { secret: 'x' }, () => 'ok')
    expect(result).toBe('ok')
    expect(events).toEqual([])
  })

  test('回归哨兵：quiet 但失败的命令仍必须记录', async () => {
    const { events, deps } = harness(['quiet_cmd'])
    await instrumentIpcCommand(deps, 'quiet_cmd', {}, () => {
      throw new Error('silent-but-logged')
    }).catch(() => {})
    expect(events).toHaveLength(1)
    expect(events[0]!.level).toBe('warn')
    expect(events[0]!.event).toBe('command.failed')
  })

  test(`耗时 >= ${SLOW_IPC_MS}ms 的成功命令升为 warn 落生产文件（注入时钟）`, async () => {
    let clock = 0
    const { events, deps } = harness()
    deps.now = () => clock
    const slow = instrumentIpcCommand(deps, 'slow', {}, () => new Promise((r) => setTimeout(r, 1)))
    clock = SLOW_IPC_MS + 5
    await slow
    expect(events[0]!.level).toBe('warn')
    expect(events[0]!.durationMs).toBe(SLOW_IPC_MS + 5)
  })
})
