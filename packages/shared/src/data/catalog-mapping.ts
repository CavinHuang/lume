import type { ModelCapabilities, ModelMeta, ModelPricing } from './model-meta'

/** 白名单 provider，按 canonical 优先级排序（先到先得去重，聚合器不入表）。 */
export const WHITELIST_PROVIDERS = [
  'anthropic', 'openai', 'google', 'zhipuai', 'deepseek', 'alibaba',
  'moonshotai', 'stepfun', 'minimax', 'xai', 'mistral', 'cohere', 'meta',
] as const

export interface CatalogCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}
export interface CatalogLimit { context?: number; input?: number; output?: number }
export interface CatalogModalities { input?: string[]; output?: string[] }
export interface CatalogModel {
  id?: string
  name?: string
  description?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  modalities?: CatalogModalities
  limit?: CatalogLimit
  cost?: CatalogCost
}
export interface CatalogProvider { id?: string; name?: string; models?: Record<string, CatalogModel> }
export interface Catalog { models?: unknown; providers?: Record<string, CatalogProvider> }

/** 单条 catalog model → ModelMeta；缺 limit.context 或 name 返回 null。 */
function mapModel(modelId: string, m: CatalogModel): ModelMeta | null {
  const contextWindow = m.limit?.context
  if (!contextWindow || !m.name) {
    console.warn(`[catalog-mapping] skip "${modelId}": missing limit.context or name`)
    return null
  }
  const capabilities: ModelCapabilities = {
    vision: Boolean(m.attachment) || (m.modalities?.input?.includes('image') ?? false),
    toolUse: m.tool_call ?? false,
    reasoning: m.reasoning ?? false,
  }
  const meta: ModelMeta = { id: modelId, displayName: m.name, contextWindow, capabilities }
  if (m.description) meta.description = m.description
  if (m.cost?.input !== undefined && m.cost?.output !== undefined) {
    const pricing: ModelPricing = { input: m.cost.input, output: m.cost.output }
    meta.pricing = pricing
  }
  return meta
}

/** 纯函数：从 catalog 映射出 generated ModelMeta[]（白名单过滤 + canonical 去重 + 字典序）。 */
export function buildGeneratedFromCatalog(catalog: Catalog): ModelMeta[] {
  const seen = new Set<string>()
  const out: ModelMeta[] = []
  for (const providerId of WHITELIST_PROVIDERS) {
    const provider = catalog.providers?.[providerId]
    if (!provider?.models) {
      console.warn(`[catalog-mapping] provider "${providerId}" not in catalog, skipping`)
      continue
    }
    for (const [modelId, m] of Object.entries(provider.models)) {
      if (seen.has(modelId)) continue
      const meta = mapModel(modelId, m)
      if (meta) {
        seen.add(modelId)
        out.push(meta)
      }
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}
