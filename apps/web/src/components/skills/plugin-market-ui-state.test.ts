import { describe, expect, test } from 'bun:test'
import type { PluginMarketItem, SkillCatalogItem } from '@lume/shared'
import {
  buildMarketCards,
  buildMarketSummary,
  buildPluginActionLabel,
  filterMarketCards,
} from './plugin-market-ui-state'

function skill(input: Partial<SkillCatalogItem> = {}): SkillCatalogItem {
  return {
    id: 'built-in:review',
    slug: 'review',
    name: 'Code Review',
    description: 'Review code',
    sourceType: 'built-in',
    trustLevel: 'trusted',
    installState: 'not-installed',
    ...input,
  }
}

function plugin(input: Partial<PluginMarketItem> = {}): PluginMarketItem {
  return {
    id: 'local-market:demo-plugin',
    pluginId: 'demo-plugin',
    name: 'Demo Plugin',
    version: '1.0.0',
    sourceType: 'subscribed-market',
    trustLevel: 'review-required',
    installState: 'not-installed',
    enableState: 'not-installed',
    capabilities: {
      skillCount: 1,
      hookEvents: [],
      mcpServerNames: [],
      commandToolNames: [],
    },
    permissions: {
      filesystemRead: [],
      filesystemWrite: [],
      networkOutbound: [],
      mcpRegister: false,
      shellAllow: false,
      toolAllow: [],
      toolAsk: [],
      toolDeny: [],
      hookEvents: [],
      riskLabels: [],
    },
    ...input,
  }
}

describe('plugin-market-ui-state', () => {
  test('builds mixed market cards for plugins and skills', () => {
    const cards = buildMarketCards({
      plugins: [plugin()],
      skills: [skill()],
    })

    expect(cards.map((card) => `${card.kind}:${card.name}`)).toEqual([
      'plugin:Demo Plugin',
      'skill:Code Review',
    ])
    expect(cards[0]?.category).toBe('插件')
    expect(cards[0]?.actionLabel).toBe('安装')
    expect(cards[1]?.category).toBe('内置')
  })

  test('filters mixed market cards by query category and source', () => {
    const cards = buildMarketCards({
      plugins: [plugin({ name: 'Database Plugin', sourceType: 'local' })],
      skills: [skill({ name: 'Release Notes', sourceType: 'github' })],
    })

    expect(filterMarketCards(cards, { query: 'database', category: '全部分类', source: '全部来源' }).map((card) => card.name))
      .toEqual(['Database Plugin'])
    expect(filterMarketCards(cards, { query: '', category: '外部市场源', source: '全部来源' }).map((card) => card.name))
      .toEqual(['Release Notes'])
    expect(filterMarketCards(cards, { query: '', category: '全部分类', source: '本地发现' }).map((card) => card.name))
      .toEqual(['Database Plugin'])
  })

  test('filters mixed market cards by selected kind', () => {
    const cards = buildMarketCards({
      plugins: [plugin({ name: 'Database Plugin' })],
      skills: [skill({ name: 'Release Notes' })],
    })

    expect(filterMarketCards(cards, { query: '', category: '全部分类', source: '全部来源', kind: 'plugin' }).map((card) => card.name))
      .toEqual(['Database Plugin'])
    expect(filterMarketCards(cards, { query: '', category: '全部分类', source: '全部来源', kind: 'skill' }).map((card) => card.name))
      .toEqual(['Release Notes'])
  })

  test('labels plugin actions from install and enable state', () => {
    expect(buildPluginActionLabel(plugin({ installState: 'not-installed', enableState: 'not-installed' }))).toBe('安装')
    expect(buildPluginActionLabel(plugin({ installState: 'update-available', enableState: 'disabled' }))).toBe('更新')
    expect(buildPluginActionLabel(plugin({ installState: 'installed', enableState: 'disabled' }))).toBe('启用')
    expect(buildPluginActionLabel(plugin({ installState: 'installed', enableState: 'workspace-enabled' }))).toBe('禁用')
    expect(buildPluginActionLabel(plugin({ installState: 'installed', enableState: 'global-enabled' }))).toBe('禁用')
  })

  test('summarizes plugin and skill counts', () => {
    expect(buildMarketSummary({
      plugins: [
        plugin({ installState: 'installed', enableState: 'workspace-enabled' }),
        plugin({ id: 'remote:other', pluginId: 'other', installState: 'not-installed', enableState: 'not-installed' }),
      ],
      skills: [
        skill({ installState: 'installed' }),
        skill({ id: 'github:release', slug: 'release', installState: 'not-installed' }),
      ],
    })).toEqual({
      totalPlugins: 2,
      installedPlugins: 1,
      enabledPlugins: 1,
      totalSkills: 2,
      installedSkills: 1,
    })
  })
})
