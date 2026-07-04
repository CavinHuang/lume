import React from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GetMarketDetailResult, PluginMarketItem } from '@lume/shared'

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <article data-x-markdown="true" className={className}>{children}</article>
  ),
}))

const { PluginDetailPage } = await import('./PluginDetailPage')

function plugin(input: Partial<PluginMarketItem> = {}): PluginMarketItem {
  return {
    id: 'local:browser',
    pluginId: 'browser',
    name: 'Browser',
    displayName: 'Browser',
    description: 'Control the in-app browser with Codex',
    version: '26.623.101652',
    sourceType: 'local',
    trustLevel: 'trusted',
    installState: 'installed',
    enableState: 'workspace-enabled',
    capabilities: {
      skillCount: 1,
      hookEvents: [],
      mcpServerNames: [],
      commandToolNames: ['browser'],
    },
    permissions: {
      filesystemRead: [],
      filesystemWrite: [],
      networkOutbound: ['127.0.0.1:*'],
      mcpRegister: false,
      shellAllow: false,
      toolAllow: ['Read'],
      toolAsk: [],
      toolDeny: [],
      hookEvents: [],
      riskLabels: ['network'],
    },
    ...input,
  }
}

function detail(item = plugin()): GetMarketDetailResult {
  return {
    item: { kind: 'plugin', plugin: item },
    inspect: {
      kind: 'plugin',
      normalized: {
        pluginId: item.pluginId,
        name: item.name,
        version: item.version,
        displayName: item.displayName,
        description: item.description,
      },
      permissionSummary: item.permissions,
      permissionsHash: 'hash-1',
      installState: item.installState,
      enableState: item.enableState,
      diagnostics: [],
    },
    diagnostics: [],
    readme: { markdown: '# Browser\n\nUse Browser from Lume.', path: 'README.md', truncated: false },
  }
}

describe('PluginDetailPage', () => {
  test('renders independent detail page with horizontal tabs and README', () => {
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={detail()}
        loading={false}
        error={null}
        busy={false}
        onBack={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnable={() => {}}
        onTryInChat={() => {}}
      />,
    )

    expect(html).toContain('插件')
    expect(html).toContain('Browser')
    expect(html).toContain('README')
    expect(html).toContain('Setup')
    expect(html).toContain('权限')
    expect(html).toContain('诊断')
    expect(html).toContain('data-x-markdown="true"')
    expect(html).toContain('在对话中试用')
  })

  test('renders README empty state when README is missing', () => {
    const noReadme = detail()
    delete noReadme.readme
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={noReadme}
        loading={false}
        error={null}
        busy={false}
        onBack={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnable={() => {}}
        onTryInChat={() => {}}
      />,
    )

    expect(html).toContain('未找到 README.md')
  })
})
