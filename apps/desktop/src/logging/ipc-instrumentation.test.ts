import { describe, expect, test } from 'bun:test'
import { instrumentIpcCommand, SLOW_IPC_MS, type IpcCommandEvent, type IpcInstrumentDeps } from './ipc-instrumentation'

function harness(quietNames: string[] = []) {
  const events: IpcCommandEvent[] = []
  const deps: IpcInstrumentDeps = {
    isQuiet: (name: string) => quietNames.includes(name),
    emit: (event) => { events.push(event) },
  }
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
    expect(events[0]!.error?.message).toBe('kaboom')

    const thrown: unknown[] = []
    await instrumentIpcCommand(deps, 'boom2', {}, () => Promise.reject('plain-string')).catch((e) => thrown.push(e))
    expect(thrown).toEqual(['plain-string'])
    expect(events[1]!.error).toBeUndefined()
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
