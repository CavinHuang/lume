import type { PluginMarketItem, SkillCatalogItem, SkillSourceType } from '@lume/shared'
import { buildSkillActionLabel } from './skill-market-state'

export type MarketCardKind = 'plugin' | 'skill'

export interface MarketCardView {
  kind: MarketCardKind
  id: string
  name: string
  description?: string
  category: string
  /** 插件 manifest 声明的市场分类（生产力/开发者工具等）；技能无此字段 */
  pluginCategory?: string
  sourceLabel: string
  actionLabel: string
  installState: PluginMarketItem['installState'] | SkillCatalogItem['installState']
  enabled: boolean
  item: PluginMarketItem | SkillCatalogItem
  needsBridge?: boolean
}

export interface MarketFilterInput {
  query: string
  category: string
  source: string
  kind?: MarketCardKind
}

export interface MarketCatalogInput {
  plugins: PluginMarketItem[]
  skills: SkillCatalogItem[]
}

export interface MarketSummary {
  totalPlugins: number
  installedPlugins: number
  enabledPlugins: number
  totalSkills: number
  installedSkills: number
}

export const MARKET_CATEGORY_OPTIONS = ['全部分类', '插件', '内置', '本地发现', '外部市场源'] as const
export const MARKET_SOURCE_OPTIONS = ['全部来源', '插件', '内置', '本地发现', '外部市场源'] as const

export const SKILL_SOURCE_LABELS: Record<SkillSourceType, string> = {
  'built-in': '内置',
  local: '本地发现',
  github: '外部市场源',
  'subscribed-market': '外部市场源',
  plugin: '插件',
}

export const PLUGIN_SOURCE_LABELS: Record<PluginMarketItem['sourceType'], string> = {
  local: '本地发现',
  github: '外部市场源',
  'subscribed-market': '外部市场源',
  legacy: '本地发现',
}

export function buildMarketCards(input: MarketCatalogInput): MarketCardView[] {
  return [
    ...input.plugins.map((plugin): MarketCardView => ({
      kind: 'plugin',
      id: plugin.id,
      name: plugin.displayName ?? plugin.name,
      description: plugin.description,
      category: '插件',
      pluginCategory: plugin.category,
      sourceLabel: PLUGIN_SOURCE_LABELS[plugin.sourceType],
      actionLabel: buildPluginActionLabel(plugin),
      installState: plugin.installState,
      enabled: plugin.enableState === 'global-enabled' || plugin.enableState === 'workspace-enabled',
      item: plugin,
      needsBridge: (plugin.marketplace?.setup?.length ?? 0) > 0,
    })),
    ...input.skills.map((skill): MarketCardView => ({
      kind: 'skill',
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: SKILL_SOURCE_LABELS[skill.sourceType],
      sourceLabel: SKILL_SOURCE_LABELS[skill.sourceType],
      actionLabel: buildSkillActionLabel(skill),
      installState: skill.installState,
      enabled: skill.installState === 'installed',
      item: skill,
    })),
  ]
}

export function filterMarketCards<T extends MarketCardView>(cards: T[], input: MarketFilterInput): T[] {
  const queryText = input.query.trim().toLowerCase()

  return cards.filter((card) => {
    const matchesQuery =
      !queryText ||
      card.name.toLowerCase().includes(queryText) ||
      card.description?.toLowerCase().includes(queryText) === true
    const matchesKind = !input.kind || card.kind === input.kind
    const matchesCategory = input.category === '全部分类' || card.category === input.category
    const matchesSource = input.source === '全部来源' || card.sourceLabel === input.source || card.category === input.source
    return matchesKind && matchesQuery && matchesCategory && matchesSource
  })
}

export function buildPluginActionLabel(item: PluginMarketItem): string {
  if (item.installState === 'not-installed') return '安装'
  if (item.installState === 'update-available') return '更新'
  if (item.enableState === 'global-enabled' || item.enableState === 'workspace-enabled') return '禁用'
  return '启用'
}

export function buildMarketSummary(input: MarketCatalogInput): MarketSummary {
  return {
    totalPlugins: input.plugins.length,
    installedPlugins: input.plugins.filter((item) => item.installState === 'installed').length,
    enabledPlugins: input.plugins.filter((item) => item.enableState === 'global-enabled' || item.enableState === 'workspace-enabled').length,
    totalSkills: input.skills.length,
    installedSkills: input.skills.filter((item) => item.installState === 'installed').length,
  }
}
