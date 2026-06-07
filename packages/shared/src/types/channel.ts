
/**
 * 渠道（Channel）相关类型定义
 *
 * 渠道是用户配置的 AI 供应商连接，包含 API Key、模型列表等信息。
 * API Key 使用 Electron safeStorage 加密后存储在本地配置文件中。
 */

/**
 * 支持的 AI 供应商类型
 */
export type ProviderType =
  | 'anthropic'
  | 'anthropic-compatible'
  | 'openai'
  | 'jina'
  | 'siliconflow'
  | 'openrouter'
  | 'deepseek'
  | 'google'
  | 'zai'
  | 'zai-coding-plan'
  | 'moonshot'
  | 'minimax'
  | 'minimax-cn'
  | 'doubao'
  | 'qwen'
  | 'qwen-portal'
  | 'kimi-coding'
  | 'ollama'
  | 'lmstudio'
  | 'opencode'
  | 'custom'
  | 'aliyun-coding-plan'
  | 'volcengine-coding-plan'
  | 'minimax-token-plan'
  | 'xiaomi-token-plan'

/** Provider 协议家族（决定请求格式） */
export type ProviderApiFamily = 'anthropic' | 'openai' | 'google'

/** 供应商分组 */
export type ProviderGroup = 'all' | 'coding-plan' | 'domestic' | 'overseas' | 'transit' | 'local' | 'custom'

export interface ProviderGroupInfo {
  key: ProviderGroup
  label: string
  providers: ProviderType[]
}

export const PROVIDER_GROUPS: ProviderGroupInfo[] = [
  { key: 'all', label: '全部', providers: [] },
  { key: 'coding-plan', label: '编程套餐', providers: ['kimi-coding', 'zai-coding-plan', 'aliyun-coding-plan', 'volcengine-coding-plan', 'minimax-token-plan', 'xiaomi-token-plan'] },
  { key: 'domestic', label: '国内平台', providers: ['deepseek', 'moonshot', 'minimax', 'minimax-cn', 'doubao', 'qwen', 'qwen-portal', 'zai'] },
  { key: 'overseas', label: '海外平台', providers: ['anthropic', 'anthropic-compatible', 'openai', 'google', 'jina'] },
  { key: 'transit', label: '中转/聚合', providers: ['openrouter', 'siliconflow', 'opencode'] },
  { key: 'local', label: '本地/其他', providers: ['ollama', 'lmstudio'] },
  { key: 'custom', label: '自定义', providers: ['custom'] },
]

export interface ChannelModelCapabilities {
  chat?: boolean
  embedding?: boolean
}

/**
 * 各供应商的默认 Base URL
 */
export const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  'anthropic-compatible': 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  jina: 'https://api.jina.ai/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  google: 'https://generativelanguage.googleapis.com',
  zai: 'https://open.bigmodel.cn/api/paas/v4',
  'zai-coding-plan': 'https://open.bigmodel.cn/api/coding/paas/v4',
  moonshot: 'https://api.moonshot.cn/v1',
  minimax: 'https://api.minimax.chat/v1',
  'minimax-cn': 'https://api.minimax.chat/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'qwen-portal': 'https://portal.qwen.ai/v1',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  opencode: '',
  custom: '',
  'aliyun-coding-plan': 'https://coding.dashscope.aliyuncs.com/v1',
  'volcengine-coding-plan': 'https://ark.cn-beijing.volces.com/api/coding/v3',
  'minimax-token-plan': 'https://api.minimaxi.com/anthropic/v1',
  'xiaomi-token-plan': 'https://token-plan-cn.xiaomimimo.com/v1',
}

/**
 * 供应商显示名称
 */
export const PROVIDER_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  'anthropic-compatible': 'Anthropic 兼容模式',
  openai: 'OpenAI',
  jina: 'Jina AI',
  siliconflow: '硅基流动',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  google: 'Google',
  zai: 'Z.ai',
  'zai-coding-plan': '智谱 GLM Coding Plan',
  moonshot: 'Moonshot / Kimi',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax CN',
  doubao: '豆包',
  qwen: '通义千问',
  'qwen-portal': '通义千问 Portal',
  'kimi-coding': 'Kimi Code Plan',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  opencode: 'OpenCode',
  custom: 'OpenAI 兼容格式',
  'aliyun-coding-plan': '阿里云 Coding Plan',
  'volcengine-coding-plan': '火山方舟 Coding Plan',
  'minimax-token-plan': 'MiniMax Token Plan',
  'xiaomi-token-plan': '小米 MiMo Token Plan',
}

/** Provider 对应协议家族 */
export const PROVIDER_API_FAMILIES: Record<ProviderType, ProviderApiFamily> = {
  anthropic: 'anthropic',
  'anthropic-compatible': 'anthropic',
  openai: 'openai',
  jina: 'openai',
  siliconflow: 'openai',
  openrouter: 'openai',
  deepseek: 'openai',
  google: 'google',
  zai: 'openai',
  'zai-coding-plan': 'openai',
  moonshot: 'openai',
  minimax: 'openai',
  'minimax-cn': 'openai',
  doubao: 'openai',
  qwen: 'openai',
  'qwen-portal': 'openai',
  'kimi-coding': 'openai',
  ollama: 'openai',
  lmstudio: 'openai',
  opencode: 'openai',
  custom: 'openai',
  'aliyun-coding-plan': 'openai',
  'volcengine-coding-plan': 'openai',
  'minimax-token-plan': 'anthropic',
  'xiaomi-token-plan': 'openai',
}

/** 协议家族显示名 */
export const PROVIDER_API_FAMILY_LABELS: Record<ProviderApiFamily, string> = {
  anthropic: 'Anthropic Messages',
  openai: 'OpenAI Compatible',
  google: 'Google Generative AI',
}

/** 自定义 Provider 可选的协议家族 */
export const CUSTOM_API_FAMILIES: Array<{ value: ProviderApiFamily; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
]

/**
 * 渠道中的模型配置
 */
export interface ChannelModel {
  /** 模型唯一标识（如 claude-sonnet-4-5-20250929） */
  id: string
  /** 模型显示名称 */
  name: string
  /** 可选别名（用于 provider/model 之外的短名称切换） */
  alias?: string
  /** 模型能力标签 */
  capabilities?: ChannelModelCapabilities
  /** 是否启用 */
  enabled: boolean
}

function includesEmbeddingKeyword(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (!normalized) return false
  return normalized.includes('embedding') || normalized.includes('embed') || normalized.includes('bge-m3')
}

export function inferChannelModelCapabilities(input: {
  provider: ProviderType
  modelId: string
  modelName?: string
  supportedGenerationMethods?: string[]
}): ChannelModelCapabilities {
  const family = PROVIDER_API_FAMILIES[input.provider]
  const hasEmbeddingKeyword =
    includesEmbeddingKeyword(input.modelId) || includesEmbeddingKeyword(input.modelName)

  if (family === 'anthropic') {
    return { chat: true }
  }

  if (family === 'google') {
    const methods = new Set((input.supportedGenerationMethods ?? []).map((item) => item.trim()))
    return {
      chat: methods.has('generateContent'),
      embedding: methods.has('embedContent') || hasEmbeddingKeyword,
    }
  }

  return {
    chat: !hasEmbeddingKeyword,
    embedding: hasEmbeddingKeyword,
  }
}

export function normalizeChannelModel(input: ChannelModel & {
  provider: ProviderType
  supportedGenerationMethods?: string[]
}): ChannelModel {
  const trimmedId = input.id.trim()
  const trimmedName = input.name.trim() || trimmedId
  const trimmedAlias = input.alias?.trim()
  const hasAlias = typeof trimmedAlias === 'string' && trimmedAlias.length > 0
  const inferred = inferChannelModelCapabilities({
    provider: input.provider,
    modelId: trimmedId,
    modelName: trimmedName,
    supportedGenerationMethods: input.supportedGenerationMethods,
  })
  const capabilities = {
    ...inferred,
    ...(input.capabilities ?? {}),
  }

  return {
    id: trimmedId,
    name: trimmedName,
    ...(hasAlias ? { alias: trimmedAlias } : { alias: undefined }),
    capabilities,
    enabled: input.enabled,
  }
}

export function getSuggestedProviderModels(provider: ProviderType): ChannelModel[] {
  if (provider === 'jina') {
    return [
      { id: 'jina-embeddings-v5-text-small', name: 'jina-embeddings-v5-text-small', enabled: true },
      { id: 'jina-embeddings-v5-text-nano', name: 'jina-embeddings-v5-text-nano', enabled: true },
      { id: 'jina-embeddings-v4', name: 'jina-embeddings-v4', enabled: true },
      { id: 'jina-embeddings-v3', name: 'jina-embeddings-v3', enabled: true },
    ].map((model) => normalizeChannelModel({ ...model, provider }))
  }
  if (provider === 'siliconflow') {
    return [
      { id: 'Qwen/Qwen3-Embedding-0.6B', name: 'Qwen/Qwen3-Embedding-0.6B', enabled: true },
      { id: 'Qwen/Qwen3-Embedding-4B', name: 'Qwen/Qwen3-Embedding-4B', enabled: true },
      { id: 'Qwen/Qwen3-Embedding-8B', name: 'Qwen/Qwen3-Embedding-8B', enabled: true },
      {
        id: 'BAAI/bge-m3',
        name: 'BAAI/bge-m3',
        enabled: true,
        capabilities: { chat: false, embedding: true },
      },
    ].map((model) => normalizeChannelModel({ ...model, provider }))
  }
  return []
}

/**
 * 渠道配置
 *
 * 存储在 ~/.lume/channels.json 中，apiKey 字段为加密后的 base64 字符串
 */
export interface Channel {
  /** 渠道唯一标识 */
  id: string
  /** 渠道名称（用户自定义） */
  name: string
  /** AI 供应商类型 */
  provider: ProviderType
  /** API Base URL */
  baseUrl: string
  /** 加密后的 API Key（base64 编码） */
  apiKey: string
  /** 可用模型列表 */
  models: ChannelModel[]
  /** 默认模型 ID（可选，未配置时使用第一个 enabled 模型） */
  defaultModelId?: string
  /** 回退模型 ID 列表（按顺序） */
  fallbackModelIds?: string[]
  /** 是否启用 */
  enabled: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
  /** 自定义渠道的协议家族（仅 provider='custom' 时使用） */
  apiFamily?: ProviderApiFamily
}

/**
 * 创建渠道时的输入数据（apiKey 为明文）
 */
export interface ChannelCreateInput {
  name: string
  provider: ProviderType
  baseUrl: string
  /** 明文 API Key，主进程会加密后存储 */
  apiKey: string
  models: ChannelModel[]
  defaultModelId?: string
  fallbackModelIds?: string[]
  /** 自定义渠道的协议家族（仅 provider='custom' 时使用） */
  apiFamily?: ProviderApiFamily
  enabled: boolean
}

/**
 * 更新渠道时的输入数据（所有字段可选）
 */
export interface ChannelUpdateInput {
  name?: string
  provider?: ProviderType
  baseUrl?: string
  /** 明文 API Key，为空字符串表示不更新 */
  apiKey?: string
  models?: ChannelModel[]
  defaultModelId?: string
  fallbackModelIds?: string[]
  /** 自定义渠道的协议家族（仅 provider='custom' 时使用） */
  apiFamily?: ProviderApiFamily
  enabled?: boolean
}

/**
 * 渠道配置文件格式
 */
export interface ChannelsConfig {
  /** 配置版本号 */
  version: number
  /** 渠道列表 */
  channels: Channel[]
}

/**
 * 连接测试结果
 */
export interface ChannelTestResult {
  /** 是否成功 */
  success: boolean
  /** 结果消息 */
  message: string
}

/**
 * 拉取模型的输入参数（无需已保存的渠道，直接传入凭证）
 */
export interface FetchModelsInput {
  provider: ProviderType
  baseUrl: string
  /** 明文 API Key */
  apiKey: string
  /** 自定义渠道的协议家族（可选，仅 custom provider 使用） */
  apiFamily?: ProviderApiFamily
}

/**
 * 拉取模型的结果
 */
export interface FetchModelsResult {
  /** 是否成功 */
  success: boolean
  /** 结果消息 */
  message: string
  /** 获取到的模型列表 */
  models: ChannelModel[]
}

/**
 * 渠道相关 IPC 通道常量
 */
export const CHANNEL_IPC_CHANNELS = {
  /** 获取所有渠道列表 */
  LIST: 'channel:list',
  /** 创建渠道 */
  CREATE: 'channel:create',
  /** 更新渠道 */
  UPDATE: 'channel:update',
  /** 删除渠道 */
  DELETE: 'channel:delete',
  /** 解密获取明文 API Key */
  DECRYPT_KEY: 'channel:decrypt-key',
  /** 测试渠道连接 */
  TEST: 'channel:test',
  /** 从供应商拉取可用模型列表 */
  FETCH_MODELS: 'channel:fetch-models',
  /** 直接测试连接（无需已保存渠道，传入明文凭证） */
  TEST_DIRECT: 'channel:test-direct',
} as const
