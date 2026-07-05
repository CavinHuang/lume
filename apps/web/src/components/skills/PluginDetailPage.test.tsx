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
    expect(html).toContain('data-plugin-detail-tabs="horizontal"')
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

  test('marks loading and error-only states for assistive tech', () => {
    const loadingHtml = renderToStaticMarkup(
      <PluginDetailPage
        detail={null}
        loading={true}
        error={null}
        busy={false}
        onBack={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnable={() => {}}
        onTryInChat={() => {}}
      />,
    )
    const errorHtml = renderToStaticMarkup(
      <PluginDetailPage
        detail={null}
        loading={false}
        error="detail failed"
        busy={false}
        onBack={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnable={() => {}}
        onTryInChat={() => {}}
      />,
    )

    expect(loadingHtml).toContain('role="status"')
    expect(errorHtml).toContain('role="alert"')
  })

  test('keeps installed management actions visible for updateable plugins', () => {
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={detail(plugin({ installState: 'update-available', enableState: 'workspace-enabled' }))}
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

    expect(html).toContain('确认权限并更新')
    expect(html).toContain('卸载')
  })

  test('uses inspected update state for setup copy when market item is stale', () => {
    const staleDetail = detail(plugin({ installState: 'not-installed', enableState: 'not-installed' }))
    if (staleDetail.inspect?.kind === 'plugin') {
      staleDetail.inspect.installState = 'update-available'
      staleDetail.inspect.enableState = 'workspace-enabled'
    }
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={staleDetail}
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

    expect(html).toContain('当前已安装，发现可更新版本')
    expect(html).not.toContain('安装后才能启用和配置连接。')
    expect(html).toContain('确认权限并更新')
    expect(html).toContain('卸载')
  })

  test('shows enable action instead of try-in-chat for installed disabled plugins', () => {
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={detail(plugin({ enableState: 'disabled' }))}
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

    expect(html).toContain('data-plugin-detail-header-action="enable"')
    expect(html).toContain('启用')
    expect(html).not.toContain('在对话中试用')
  })

  test('disables install and update actions when inspect is missing', () => {
    const missingInspect = detail(plugin({ installState: 'not-installed', enableState: 'not-installed' }))
    delete missingInspect.inspect
    const installHtml = renderToStaticMarkup(
      <PluginDetailPage
        detail={missingInspect}
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
    const missingUpdateInspect = detail(plugin({ installState: 'update-available' }))
    delete missingUpdateInspect.inspect
    const updateHtml = renderToStaticMarkup(
      <PluginDetailPage
        detail={missingUpdateInspect}
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

    expect(installHtml).toContain('确认权限并安装')
    expect(installHtml).toContain('data-plugin-detail-install-action="disabled"')
    expect(updateHtml).toContain('确认权限并更新')
    expect(updateHtml).toContain('data-plugin-detail-install-action="disabled"')
  })

  test('deduplicates diagnostics from detail and item', () => {
    const diagnostic = {
      severity: 'warning' as const,
      code: 'same-warning',
      message: 'Same diagnostic warning',
    }
    const withDuplicateDiagnostics = detail(plugin({ diagnostics: [diagnostic] }))
    withDuplicateDiagnostics.diagnostics = [diagnostic]
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={withDuplicateDiagnostics}
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

    expect(html.match(/Same diagnostic warning/g)?.length).toBe(1)
  })
})
