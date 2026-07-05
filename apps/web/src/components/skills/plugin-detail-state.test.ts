import { describe, expect, test } from 'bun:test'
import type { PluginMarketItem } from '@lume/shared'
import {
  buildPermissionRows,
  buildPluginSetupItems,
  formatPluginEnableState,
  formatPluginInstallState,
  formatReadmeMeta,
  formatRiskLabel,
} from './plugin-detail-state'

function plugin(input: Partial<PluginMarketItem> = {}): PluginMarketItem {
  return {
    id: 'local:demo',
    pluginId: 'demo',
    name: 'Demo',
    version: '1.0.0',
    sourceType: 'local',
    trustLevel: 'trusted',
    installState: 'installed',
    enableState: 'workspace-enabled',
    capabilities: {
      skillCount: 1,
      hookEvents: ['SessionStart'],
      mcpServerNames: ['mcp.json'],
      commandToolNames: ['demo_run'],
    },
    permissions: {
      filesystemRead: ['./docs/**'],
      filesystemWrite: ['./data/**'],
      networkOutbound: ['127.0.0.1:*'],
      mcpRegister: true,
      shellAllow: false,
      toolAllow: ['Read'],
      toolAsk: ['Bash'],
      toolDeny: [],
      hookEvents: ['SessionStart'],
      riskLabels: ['network', 'write', 'mcp'],
    },
    ...input,
  }
}

describe('plugin-detail-state', () => {
  test('formats plugin states and risk labels', () => {
    expect(formatPluginInstallState('installed')).toBe('已安装')
    expect(formatPluginInstallState('update-available')).toBe('有更新')
    expect(formatPluginEnableState('workspace-enabled')).toBe('工作区启用')
    expect(formatRiskLabel('network')).toBe('网络')
  })

  test('builds permission rows from plugin permissions', () => {
    const rows = buildPermissionRows(plugin())
    expect(rows.find((row) => row.label === '网络访问')?.value).toBe('127.0.0.1:*')
    expect(rows.find((row) => row.label === '写入文件')?.value).toBe('./data/**')
    expect(rows.find((row) => row.label === 'Shell')?.value).toBe('未声明')
  })

  test('builds setup checklist from plugin shape', () => {
    const items = buildPluginSetupItems(plugin())
    expect(items.map((item) => item.title)).toEqual([
      '确认插件已安装',
      '启用当前工作区',
      '完成本地桥接配对',
    ])
    expect(items.some((item) => item.status === 'attention')).toBe(true)
  })

  test('builds setup guidance for Chrome authorization and Obsidian pairing', () => {
    const chromeByToolItems = buildPluginSetupItems(plugin({
      name: 'browser-bridge',
      pluginId: 'browser-bridge',
      capabilities: {
        skillCount: 1,
        hookEvents: [],
        mcpServerNames: [],
        commandToolNames: [],
      },
      permissions: {
        ...plugin().permissions,
        networkOutbound: [],
        mcpRegister: false,
        toolAllow: ['mcp__node_repl__js'],
      },
    }))
    const chromeByNameItems = buildPluginSetupItems(plugin({
      name: 'lume-chrome',
      pluginId: 'lume-chrome',
      capabilities: {
        skillCount: 1,
        hookEvents: [],
        mcpServerNames: [],
        commandToolNames: [],
      },
      permissions: {
        ...plugin().permissions,
        networkOutbound: [],
        mcpRegister: false,
        toolAllow: [],
      },
    }))
    const obsidianItems = buildPluginSetupItems(plugin({
      name: 'obsidian-bridge',
      pluginId: 'obsidian-bridge',
      capabilities: {
        skillCount: 1,
        hookEvents: [],
        mcpServerNames: ['obsidian'],
        commandToolNames: [],
      },
      permissions: {
        ...plugin().permissions,
        networkOutbound: ['127.0.0.1:43112'],
        mcpRegister: false,
        toolAllow: [],
      },
    }))

    expect(chromeByToolItems.find((item) => item.title === '完成浏览器授权')?.description).toContain('授权弹窗')
    expect(chromeByNameItems.find((item) => item.title === '完成浏览器授权')?.description).toContain('授权弹窗')
    expect(obsidianItems.find((item) => item.title === '完成本地桥接配对')?.description).toContain('验证码')
  })

  test('formats setup install item for installed, updateable, and missing plugins', () => {
    expect(buildPluginSetupItems(plugin({ installState: 'not-installed', enableState: 'not-installed' }))[0]).toEqual({
      title: '确认插件已安装',
      description: '安装后才能启用和配置连接。',
      status: 'attention',
    })
    expect(buildPluginSetupItems(plugin({ installState: 'installed' }))[0]).toEqual({
      title: '确认插件已安装',
      description: '当前版本 1.0.0 已安装。',
      status: 'done',
    })
    expect(buildPluginSetupItems(plugin({ installState: 'update-available' }))[0]).toEqual({
      title: '确认插件已安装',
      description: '当前已安装，发现可更新版本 1.0.0。',
      status: 'attention',
    })
  })

  test('formats README metadata', () => {
    expect(formatReadmeMeta({ markdown: '# Demo', path: 'README.md', truncated: false })).toBe('README.md')
    expect(formatReadmeMeta({ markdown: '# Demo', path: 'README.md', truncated: true })).toBe('README.md · 已截断')
    expect(formatReadmeMeta(undefined)).toBe('未找到 README.md')
  })
})
