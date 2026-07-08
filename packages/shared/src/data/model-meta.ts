/**
 * Static model metadata registry.
 */

import generatedJson from './model-meta.generated.json'
import { MODEL_OVERRIDES } from './model-meta.override'
import { mergeModelMeta } from './merge-models'

export interface ModelCapabilities {
  vision?: boolean
  toolUse?: boolean
  reasoning?: boolean
}

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
}

export interface ModelMeta {
  /** Canonical model ID for exact matching */
  id: string
  /** Alternative IDs/names that also match this entry */
  aliases?: string[]
  /** Human-readable display name */
  displayName: string
  /** Context window size in tokens */
  contextWindow: number
  /** Model capabilities */
  capabilities: ModelCapabilities
  /** Pricing per 1M tokens (USD), omitted if unknown */
  pricing?: ModelPricing
  /** Brief description for future tooltip use */
  description?: string
}

/**
 * 最终注册表 = generated（models.dev 同步）⊕ override（人工稳定层）。
 * 公开 API 行为与原硬编码 registry 一致。运行时可经 setModelMeta 替换。
 */
let MODEL_META_REGISTRY: ModelMeta[] = mergeModelMeta(
  generatedJson as unknown as ModelMeta[],
  MODEL_OVERRIDES,
)

/** build-time bundled seed（运行时 fallback / 初始值），供测试恢复等场景使用 */
export const MODEL_META_SEED: ModelMeta[] = generatedJson as unknown as ModelMeta[]

function buildLookupMap(registry: ModelMeta[]): Map<string, ModelMeta> {
  const map = new Map<string, ModelMeta>()
  for (const meta of registry) {
    map.set(meta.id, meta)
    if (meta.aliases) {
      for (const alias of meta.aliases) {
        map.set(alias, meta)
      }
    }
  }
  return map
}

let lookupMap = buildLookupMap(MODEL_META_REGISTRY)

/**
 * 运行时替换 registry：接收未 merge 的原始 generated，内部应用 override 后重建 lookupMap。
 * 供 web 启动期加载 / reload 时调用。findModelMeta 同步签名不变。
 */
export function setModelMeta(generated: ModelMeta[]): void {
  MODEL_META_REGISTRY = mergeModelMeta(generated, MODEL_OVERRIDES)
  lookupMap = buildLookupMap(MODEL_META_REGISTRY)
}

/** Strip provider prefix (e.g., "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5") */
function stripProviderPrefix(id: string): string {
  const slashIndex = id.indexOf('/')
  if (slashIndex > 0 && slashIndex < id.length - 1) {
    return id.slice(slashIndex + 1)
  }
  return id
}

/**
 * Find model metadata by model ID.
 * Handles: exact match, alias match, case-insensitive, provider-prefixed IDs, prefix match.
 * Returns undefined for unknown models.
 */
export function findModelMeta(modelId: string): ModelMeta | undefined {
  const candidates = [modelId, stripProviderPrefix(modelId)]

  for (const candidate of candidates) {
    const exact = lookupMap.get(candidate)
    if (exact) return exact

    const lower = candidate.toLowerCase()
    for (const [key, meta] of lookupMap) {
      if (key.toLowerCase() === lower) return meta
    }

    for (const meta of MODEL_META_REGISTRY) {
      if (candidate.startsWith(meta.id) || meta.id.startsWith(candidate)) return meta
      if (meta.aliases?.some((alias) => candidate.startsWith(alias) || alias.startsWith(candidate))) return meta
    }
  }

  return undefined
}

/**
 * Infer basic capabilities from model ID/name for models not in the registry.
 * Uses keyword heuristics.
 */
export function inferCapabilities(modelId: string, modelName?: string): ModelCapabilities {
  const text = `${modelId} ${modelName ?? ''}`.toLowerCase()

  return {
    vision: /vision|image|gpt-4o|gpt-4-turbo|claude-3|claude-4|gemini|glm-4v|qwen-vl/.test(text),
    toolUse: !/embed/.test(text),
    reasoning: /reason|think|o1|o3|o4|r1|deepthink/.test(text),
  }
}

/** Format context window size for display */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000) return `${tokens / 1_000}K`
  return String(tokens)
}

/** Format pricing for display */
export function formatPricing(pricing: ModelPricing): string {
  const fmt = (n: number) => String(n)
  return `$${fmt(pricing.input)}/$${fmt(pricing.output)}`
}
