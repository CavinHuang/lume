import { describe, expect, mock, test } from 'bun:test'
import type { PluginMarketplaceSetupStep } from '@lume/shared'

const installPluginPackage = mock(async (input: { setupStepId: string }) => ({
  status: 'installed' as const,
  hostName: `host:${input.setupStepId}`,
  hostPath: '/tmp/host',
  manifestPath: '/tmp/manifest.json',
}))

mock.module('@/lib/desktop-api', () => ({ installPluginPackage }))

const { installPluginSetupPackages } = await import('./plugin-setup-installer')

describe('installPluginSetupPackages', () => {
  test('installs every declared installer step in order', async () => {
    const setup: PluginMarketplaceSetupStep[] = [
      { id: 'extension', title: '扩展', description: '保存扩展包' },
      {
        id: 'native-host',
        title: 'Host',
        description: '安装 Host',
        installer: {
          kind: 'chrome-native-host',
          hostName: 'com.lume.browser',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          appServerUrl: 'ws://127.0.0.1:43127/browser',
        },
      },
    ]

    const results = await installPluginSetupPackages({ workspaceSlug: 'workspace', catalogItemKey: 'catalog', setup })

    expect(installPluginPackage).toHaveBeenCalledTimes(1)
    expect(installPluginPackage).toHaveBeenCalledWith({
      workspaceSlug: 'workspace',
      catalogItemKey: 'catalog',
      setupStepId: 'native-host',
    })
    expect(results[0]?.hostName).toBe('host:native-host')
  })

  test('requires a live catalog snapshot only when an installer is declared', async () => {
    await expect(installPluginSetupPackages({
      workspaceSlug: 'workspace',
      setup: [{
        id: 'native-host',
        title: 'Host',
        description: '安装 Host',
        installer: {
          kind: 'chrome-native-host',
          hostName: 'com.lume.browser',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          appServerUrl: 'ws://127.0.0.1:43127/browser',
        },
      }],
    })).rejects.toThrow(/目录快照已失效/)

    await expect(installPluginSetupPackages({ workspaceSlug: 'workspace' })).resolves.toEqual([])
  })
})
