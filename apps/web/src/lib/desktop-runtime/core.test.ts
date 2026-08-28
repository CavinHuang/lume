import { afterEach, describe, expect, test } from 'bun:test'
import { invoke } from './core'
import type { DesktopBridgeAPI } from './bridge'

// #782：main 侧错误经 envelope（普通对象，跨 ipc/contextBridge 序列化保真）
// 抵达 renderer，desktop-runtime invoke 解包为带 code 的 Error——code 属性
// 在 renderer 进程内合成，不再被序列化剥离，消费方 extractRpcErrorCode 可判别。
describe('desktop-runtime invoke envelope 解包 (#782)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  function installBridge(invokeImpl: DesktopBridgeAPI['invoke']): void {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        invoke: invokeImpl,
        listen: async () => () => {},
      },
    }
  }

  test('envelope 返回值解包为带 code 的 rejection', async () => {
    installBridge(async () => ({
      __lumeRpcError: true,
      code: 'rpc_timeout',
      message: 'sidecar request timed out: agent:list-threads',
    }))
    let caught: unknown
    try {
      await invoke('agent:list-threads', {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({
      code: 'rpc_timeout',
      message: 'sidecar request timed out: agent:list-threads',
    })
  })

  test('正常返回值透传，不受哨兵键误判', async () => {
    installBridge(async () => ({ ok: true, value: 42 }))
    await expect(invoke('some:command')).resolves.toEqual({ ok: true, value: 42 })
  })
})
