import React from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { bridgeWizardOpenAtom, bridgeWizardPluginAtom } from '@/atoms'
import type { PluginMarketItem } from '@lume/shared'

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }))

const { BridgeInstallWizard } = await import('./BridgeInstallWizard')

function bridgePlugin(): PluginMarketItem {
  return {
    id: 'local:demo', pluginId: 'demo', name: 'Demo', version: '1.0.0',
    sourceType: 'local', trustLevel: 'trusted',
    installState: 'not-installed', enableState: 'not-installed',
    capabilities: { skillCount: 0, hookEvents: [], mcpServerNames: [], commandToolNames: [] },
    permissions: { filesystemRead: [], filesystemWrite: [], networkOutbound: [], mcpRegister: false, shellAllow: false, toolAllow: [], toolAsk: [], toolDeny: [], hookEvents: [], riskLabels: [] },
    marketplace: {
      setup: [{
        id: 'install-ext', title: '安装扩展', description: '加载已解压', kind: 'install',
        artifact: { path: './ext.zip', kind: 'chrome-extension' },
        targetApp: { kind: 'chrome', installHint: 'chrome://extensions' },
      }],
    },
  }
}

describe('BridgeInstallWizard', () => {
  test('open 时渲染步骤标题与导出按钮', () => {
    const store = createStore()
    store.set(bridgeWizardOpenAtom, true)
    store.set(bridgeWizardPluginAtom, bridgePlugin())
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <BridgeInstallWizard workspaceSlug="default" />
      </Provider>,
    )
    expect(html).toContain('安装扩展')
    expect(html).toContain('导出')
  })

  test('未 open 时不渲染内容', () => {
    const store = createStore()
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <BridgeInstallWizard workspaceSlug="default" />
      </Provider>,
    )
    expect(html).not.toContain('安装扩展')
  })
})
