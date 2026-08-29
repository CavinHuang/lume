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
      mcpServerNames: ['image_search'],
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
        author: 'Z.ai',
        root: 'C:/plugins/cache/browser/26.623.101652',
      },
      skills: [
        { name: 'browser-navigate', description: 'Open URLs and navigate pages.' },
        { name: 'browser-snapshot', description: 'Capture an accessibility snapshot.' },
      ],
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
  test('renders single-scroll detail page with breadcrumb and README', () => {
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

    expect(html).toContain('插件市场')
    expect(html).toContain('Browser')
    expect(html).toContain('MCP 服务器')
    expect(html).toContain('browser-navigate')
    expect(html).toContain('Open URLs and navigate pages.')
    expect(html).toContain('开发者')
    expect(html).toContain('Z.ai')
    expect(html).toContain('根路径')
    expect(html).toContain('C:/plugins/cache/browser/26.623.101652')
    expect(html).toContain('高级信息')
    expect(html).not.toContain('Setup')
    expect(html).toContain('data-plugin-detail-shell="full-width"')
    expect(html).toContain('flex-1')
    expect(html).not.toContain('data-plugin-detail-tabs')
    expect(html).not.toContain('权限审核')
    expect(html).toContain('立即试用')
  })

  test('renders marketplace media, links, and explicit setup copy', () => {
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={detail(plugin({
          marketplace: {
            icon: { path: './assets/icon.svg', url: 'data:image/svg+xml;base64,aWNvbg==' },
            thumbnail: { path: './assets/thumbnail.svg', url: 'data:image/svg+xml;base64,dGh1bWI=' },
            docs: './README.md',
            website: 'https://example.com/browser',
            setup: [
              {
                id: 'auth',
                title: '确认浏览器授权',
                description: '在 Lume 授权弹窗里确认 Chrome 请求。',
                kind: 'browser-auth',
              },
            ],
          },
        }))}
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

    expect(html).toContain('data-plugin-marketplace-icon="true"')
    expect(html).toContain('data-plugin-marketplace-media="true"')
    expect(html).toContain('https://example.com/browser')
    expect(html).toContain('./README.md')
    expect(html).toContain('确认浏览器授权')
    expect(html).toContain('在 Lume 授权弹窗里确认 Chrome 请求。')
  })

  test('renders a direct Native Host install action for precompiled runtimes', () => {
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={detail(plugin({
          marketplace: {
            setup: [{
              id: 'install-host',
              title: '安装 Native Host',
              description: '无需本地构建。',
              kind: 'install',
              artifacts: [{
                path: './runtime/win32-x64/lume-chrome-host.exe',
                kind: 'native-binary',
                platform: 'win32',
                arch: 'x64',
              }],
              installer: {
                kind: 'chrome-native-host',
                hostName: 'com.lume.browser',
                extensionId: 'abcdefghijklmnopabcdefghijklmnop',
                appServerUrl: 'ws://127.0.0.1:43127/browser',
              },
            }],
          },
        }))}
        loading={false}
        error={null}
        busy={false}
        onBack={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnable={() => {}}
        onTryInChat={() => {}}
        onPreparePackage={() => {}}
        onInstallPackage={() => {}}
      />,
    )

    expect(html).toContain('安装 Native Host')
    expect(html).not.toContain('保存配套包')
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
        detail={detail(plugin({
          installState: 'update-available',
          enableState: 'workspace-enabled',
          installedVersion: '26.623.101651',
          rollbackVersion: '26.623.101650',
          installedPermissionsHash: 'hash-1',
        }))}
        loading={false}
        error={null}
        busy={false}
        onBack={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnable={() => {}}
        onTryInChat={() => {}}
        onRollback={() => {}}
      />,
    )

    expect(html).toContain('更新到 v26.623.101652')
    expect(html).toContain('当前版本')
    expect(html).toContain('v26.623.101651')
    expect(html).toContain('可更新版本')
    expect(html).toContain('回滚到 v26.623.101650')
    expect(html).toContain('title="更多操作"')
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

    expect(html).toContain('有更新')
    expect(html).not.toContain('安装后才能启用和配置连接。')
    expect(html).toContain('确认权限并更新')
    expect(html).toContain('title="更多操作"')
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
