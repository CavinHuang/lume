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

  // ── Z.AI / 智谱 ──
  {
    id: 'glm-4-plus',
    displayName: 'GLM-4 Plus',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
  },
  {
    id: 'glm-4-air',
    displayName: 'GLM-4 Air',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
  },
  {
    id: 'glm-4-airx',
    displayName: 'GLM-4 AirX',
    contextWindow: 8_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'glm-4-long',
    displayName: 'GLM-4 Long',
    contextWindow: 1_000_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'glm-4-flash',
    aliases: ['glm-4-flash-250414'],
    displayName: 'GLM-4 Flash',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
  },
  {
    id: 'glm-4-flashx',
    displayName: 'GLM-4 FlashX',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'glm-4v',
    aliases: ['glm-4v-plus', 'glm-4v-flash'],
    displayName: 'GLM-4V',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
  },
  {
    id: 'glm-4.5',
    displayName: 'GLM-4.5',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },
  {
    id: 'glm-4.6',
    displayName: 'GLM-4.6',
    contextWindow: 200_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },
  {
    id: 'glm-4.7',
    displayName: 'GLM-4.7',
    contextWindow: 200_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },
  {
    id: 'glm-5',
    displayName: 'GLM-5',
    contextWindow: 200_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },
  {
    id: 'glm-5-turbo',
    displayName: 'GLM-5 Turbo',
    contextWindow: 200_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },
  {
    id: 'glm-5.1',
    displayName: 'GLM-5.1',
    contextWindow: 200_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },
  {
    id: 'glm-z1-air',
    displayName: 'GLM-Z1 Air',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },
  {
    id: 'glm-z1-airx',
    displayName: 'GLM-Z1 AirX',
    contextWindow: 8_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },
  {
    id: 'glm-z1-flash',
    displayName: 'GLM-Z1 Flash',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },

  // ── Moonshot / Kimi ──
  {
    id: 'moonshot-v1-8k',
    displayName: 'Moonshot V1 8K',
    contextWindow: 8_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'moonshot-v1-32k',
    displayName: 'Moonshot V1 32K',
    contextWindow: 32_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'moonshot-v1-128k',
    displayName: 'Moonshot V1 128K',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'kimi-latest',
    aliases: ['kimi'],
    displayName: 'Kimi Latest',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
  },

  // ── Qwen / 通义千问 ──
  {
    id: 'qwen-max',
    displayName: 'Qwen Max',
    contextWindow: 32_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'qwen-plus',
    displayName: 'Qwen Plus',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'qwen-turbo',
    displayName: 'Qwen Turbo',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'qwen-vl-max',
    displayName: 'Qwen VL Max',
    contextWindow: 32_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
  },
  {
    id: 'qwen-long',
    displayName: 'Qwen Long',
    contextWindow: 1_000_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'qwq-32b',
    aliases: ['qwq'],
    displayName: 'QwQ 32B',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
  },

  // ── 豆包 / 字节 ──
  {
    id: 'doubao-pro-32k',
    displayName: 'Doubao Pro 32K',
    contextWindow: 32_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'doubao-pro-128k',
    displayName: 'Doubao Pro 128K',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'doubao-lite-32k',
    displayName: 'Doubao Lite 32K',
    contextWindow: 32_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
  {
    id: 'doubao-1.5-pro',
    displayName: 'Doubao 1.5 Pro',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
  },
  {
    id: 'doubao-1.5-lite',
    displayName: 'Doubao 1.5 Lite',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },

  // ── 阶跃星辰 Stepfun ──
  {
    id: 'step-3.7-flash',
    displayName: 'Step 3.7 Flash',
    contextWindow: 131_072,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    description: '阶跃星辰旗舰多模态推理模型，支持三档推理强度',
  },
  {
    id: 'step-3.5-flash-2603',
    aliases: ['step-3.5-flash-2603'],
    displayName: 'Step 3.5 Flash 2603',
    contextWindow: 131_072,
    capabilities: { vision: false, toolUse: true, reasoning: true },
    description: '针对高频 Agent 场景优化，Token 效率提升、推理速度更快',
  },
  {
    id: 'step-3.5-flash',
    displayName: 'Step 3.5 Flash',
    contextWindow: 131_072,
    capabilities: { vision: false, toolUse: true, reasoning: true },
    description: '196B MoE 架构，高速推理，专为智能体和代码任务优化',
  },
  {
    id: 'step-router-v1',
    displayName: 'Step Router V1',
    contextWindow: 131_072,
    capabilities: { vision: false, toolUse: true, reasoning: true },
    description: '智能路由模型，自动在 deepseek-v4-pro 与 step-3.5-flash 之间切换',
  },

  // ── MiniMax ──
  {
    id: 'minimax-text-01',
    displayName: 'MiniMax Text 01',
    contextWindow: 1_000_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },

  // ── OpenRouter common passthrough models ──
  {
    id: 'claude-sonnet-4-5',
    aliases: ['claude-3-5-sonnet-20241022'],
    displayName: 'Claude Sonnet 4.5',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 3, output: 15 },
  },
  {
    id: 'claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 15, output: 75 },
  },
  {
    id: 'gpt-4.1',
    displayName: 'GPT-4.1',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 2, output: 8 },
  },
  {
    id: 'gpt-4.1-mini',
    aliases: ['openai/gpt-4.1-mini'],
    displayName: 'GPT-4.1 mini',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 0.4, output: 1.6 },
  },
  {
    id: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 nano',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 0.1, output: 0.4 },
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
