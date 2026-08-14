import { describe, expect, test } from 'bun:test'
import {
  PluginBridgeError,
  PluginBridgeService,
} from './plugin-bridge-service'

describe('PluginBridgeService', () => {
  test('checkBridgeStatus tcp-port 检测未监听端口返回 ok=false', async () => {
    const result = await new PluginBridgeService().checkBridgeStatus({
      pluginId: 'demo',
      version: '1.0.0',
      verify: { method: 'tcp-port', detail: '127.0.0.1:59999' },
    })
    expect(result.ok).toBe(false)
  })

  test('checkBridgeStatus tcp-port 拒绝非本地地址', async () => {
    expect(
      new PluginBridgeService().checkBridgeStatus({
        pluginId: 'demo',
        version: '1.0.0',
        verify: { method: 'tcp-port', detail: '8.8.8.8:53' },
      }),
    ).rejects.toBeInstanceOf(PluginBridgeError)
  })
})
