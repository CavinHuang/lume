// terminal-bridge 中继测试:invoke 命令 → sidecar fork RPC 的转发面,
// 以及 terminal:data 通知拦截/坏载荷防御。PTY 执行体不在此层。
import { describe, expect, test } from 'bun:test'
import { TERMINAL_IPC_CHANNELS, TERMINAL_SIDECAR_METHODS } from '@lume/shared'
import { createTerminalRelay } from '../terminal-bridge'

function createHarness() {
  const sidecarCalls: Array<{ method: string; params?: unknown }> = []
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const relay = createTerminalRelay({
    callSidecar: async <T,>(method: string, params?: unknown) => {
      sidecarCalls.push({ method, params })
      return { ok: true, method } as T
    },
    emitEvent: (channel, payload) => emitted.push({ channel, payload }),
  })
  return { relay, sidecarCalls, emitted }
}

describe('handleRendererCommand', () => {
  test('create 透传载荷并透传 sidecar 返回的 {id, shell}', async () => {
    const { relay, sidecarCalls } = createHarness()
    const result = (await relay.handleRendererCommand(TERMINAL_IPC_CHANNELS.create, {
      cwd: 'C:\\repos',
      cols: 100,
      rows: 30,
    })) as Record<string, unknown>

    expect(sidecarCalls).toEqual([
      { method: TERMINAL_SIDECAR_METHODS.create, params: { cwd: 'C:\\repos', cols: 100, rows: 30 } },
    ])
    expect(result.method).toBe(TERMINAL_SIDECAR_METHODS.create)
  })

  test('write/resize/dispose 逐一对准 sidecar 方法名', async () => {
    const { relay, sidecarCalls } = createHarness()

    await relay.handleRendererCommand(TERMINAL_IPC_CHANNELS.write, { id: 't1', data: 'ls\r\n' })
    await relay.handleRendererCommand(TERMINAL_IPC_CHANNELS.resize, { id: 't1', cols: 80, rows: 24 })
    await relay.handleRendererCommand(TERMINAL_IPC_CHANNELS.dispose, { id: 't1' })

    expect(sidecarCalls.map((call) => call.method)).toEqual([
      TERMINAL_SIDECAR_METHODS.write,
      TERMINAL_SIDECAR_METHODS.resize,
      TERMINAL_SIDECAR_METHODS.dispose,
    ])
    expect(sidecarCalls[0]!.params).toEqual({ id: 't1', data: 'ls\r\n' })
  })

  test('未知命令抛错(白名单已限定,此处兜底)', async () => {
    const { relay } = createHarness()
    await expect(relay.handleRendererCommand('lume:terminal-unknown', {})).rejects.toThrow(/unsupported/)
  })
})

describe('handleSidecarNotification', () => {
  test('terminal:data 转发为 lume:terminal-data 事件并声明已消费', () => {
    const { relay, emitted } = createHarness()
    const consumed = relay.handleSidecarNotification(TERMINAL_SIDECAR_METHODS.data, { id: 't1', data: 'hello' })

    expect(consumed).toBe(true)
    expect(emitted).toEqual([{ channel: TERMINAL_IPC_CHANNELS.data, payload: { id: 't1', data: 'hello' } }])
  })

  test('坏载荷静默吞掉(不再落入通用通知路径)', () => {
    const { relay, emitted } = createHarness()
    expect(relay.handleSidecarNotification(TERMINAL_SIDECAR_METHODS.data, { id: 1 })).toBe(true)
    expect(relay.handleSidecarNotification(TERMINAL_SIDECAR_METHODS.data, null)).toBe(true)
    expect(emitted).toEqual([])
  })

  test('terminal:exit 转发为 lume:terminal-exit 事件;非数值 exitCode 规整为 null', () => {
    const { relay, emitted } = createHarness()
    expect(relay.handleSidecarNotification(TERMINAL_SIDECAR_METHODS.exit, { id: 't1', exitCode: 0 })).toBe(true)
    expect(relay.handleSidecarNotification(TERMINAL_SIDECAR_METHODS.exit, { id: 't2', exitCode: 'x' })).toBe(true)
    expect(emitted).toEqual([
      { channel: TERMINAL_IPC_CHANNELS.exit, payload: { id: 't1', exitCode: 0 } },
      { channel: TERMINAL_IPC_CHANNELS.exit, payload: { id: 't2', exitCode: null } },
    ])
    expect(relay.handleSidecarNotification(TERMINAL_SIDECAR_METHODS.exit, { exitCode: 0 })).toBe(true)
    expect(emitted).toHaveLength(2)
  })

  test('其它通知返回 false 交还通用路径', () => {
    const { relay, emitted } = createHarness()
    expect(relay.handleSidecarNotification('agent:title-updated', {})).toBe(false)
    expect(emitted).toEqual([])
  })
})
