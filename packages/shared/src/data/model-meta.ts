/**
 * Static model metadata registry.
 */

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

const MODEL_META_REGISTRY: ModelMeta[] = [
  // ── Anthropic ──
  {
    id: 'claude-sonnet-4-20250514',
    aliases: [
      'claude-sonnet-4',
      'claude-3-5-sonnet',
      'claude-3-5-sonnet-20241022',
      'claude-3.5-sonnet',
      'anthropic/claude-sonnet-4-5',
    ],
    displayName: 'Claude Sonnet 4',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 3, output: 15 },
    description: '擅长代码和日常任务',
  },
  {
    id: 'claude-opus-4-20250514',
    aliases: ['claude-opus-4', 'claude-3-opus', 'claude-3-opus-20240229'],
    displayName: 'Claude Opus 4',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 15, output: 75 },
    description: '最强推理能力',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    aliases: ['claude-haiku-4-5', 'claude-3-5-haiku', 'claude-3-5-haiku-20241022'],
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 0.8, output: 4 },
    description: '快速响应，经济实惠',
  },

  // ── OpenAI ──
  {
    id: 'gpt-4o',
    aliases: ['gpt-4o-2024-11-20', 'gpt-4o-2024-08-06'],
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 2.5, output: 10 },
    description: 'OpenAI 旗舰模型',
  },
  {
    id: 'gpt-4o-mini',
    aliases: ['gpt-4o-mini-2024-07-18'],
    displayName: 'GPT-4o mini',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 0.15, output: 0.6 },
  },
  {
    id: 'o3',
    aliases: ['o3-2025-04-16'],
    displayName: 'o3',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 10, output: 40 },
  },
  {
    id: 'o3-mini',
    aliases: ['o3-mini-2025-01-31'],
    displayName: 'o3-mini',
    contextWindow: 200_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
    pricing: { input: 1.1, output: 4.4 },
  },
  {
    id: 'o4-mini',
    aliases: ['o4-mini-2025-04-16'],
    displayName: 'o4-mini',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 1.1, output: 4.4 },
  },

  // ── Google ──
  {
    id: 'gemini-2.5-pro',
    aliases: ['gemini-2.5-pro-preview-05-06'],
    displayName: 'Gemini 2.5 Pro',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 1.25, output: 10 },
    description: '超长上下文窗口',
  },
  {
    id: 'gemini-2.5-flash',
    aliases: ['gemini-2.5-flash-preview-05-20'],
    displayName: 'Gemini 2.5 Flash',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 0.15, output: 0.6 },
  },
  {
    id: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 0.1, output: 0.4 },
  },

  // ── DeepSeek ──
  {
    id: 'deepseek-r1',
    aliases: ['deepseek-reasoner'],
    displayName: 'DeepSeek R1',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: false, reasoning: true },
    pricing: { input: 0.55, output: 2.19 },
  },
  {
    id: 'deepseek-chat',
    aliases: ['deepseek-v3'],
    displayName: 'DeepSeek V3',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
    pricing: { input: 0.27, output: 1.1 },
  },
]

function buildLookupMap(): Map<string, ModelMeta> {
  const map = new Map<string, ModelMeta>()
  for (const meta of MODEL_META_REGISTRY) {
    map.set(meta.id, meta)
    if (meta.aliases) {
      for (const alias of meta.aliases) {
        map.set(alias, meta)
      }
    }
  }
  return map
}

const lookupMap = buildLookupMap()

/**
 * Find model metadata by model ID.
 * Returns undefined for unknown models.
 */
export function findModelMeta(modelId: string): ModelMeta | undefined {
  const exact = lookupMap.get(modelId)
  if (exact) return exact

  const lower = modelId.toLowerCase()
  for (const [key, meta] of lookupMap) {
    if (key.toLowerCase() === lower) return meta
  }

  for (const meta of MODEL_META_REGISTRY) {
    if (modelId.startsWith(meta.id) || meta.id.startsWith(modelId)) return meta
    if (meta.aliases?.some((alias) => modelId.startsWith(alias) || alias.startsWith(modelId))) return meta
  }

  return undefined
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
