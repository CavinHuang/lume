import type { Channel, ChannelCreateInput, LumeConfigThinkingLevel, ProviderType } from '@lume/shared'
import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS } from '@lume/shared'

export type PermissionModeValue = 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan'

export type PermissionModeTone = 'sky' | 'emerald' | 'amber' | 'violet'

export type PermissionModeIconKey = 'shield' | 'pencil' | 'shield-check' | 'shield-off' | 'map'

export interface PermissionOption {
  value: PermissionModeValue
  label: string
  desc: string
  icon: PermissionModeIconKey
  tone: PermissionModeTone
  emphasis: string
}

export const TONE_CLASS: Record<PermissionModeTone, string> = {
  sky: 'bg-sky-500/10 text-sky-600 border-sky-500/15 dark:text-sky-400',
  emerald:
    'bg-emerald-500/10 text-emerald-600 border-emerald-500/15 dark:text-emerald-400',
  amber:
    'bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-300',
  violet:
    'bg-violet-500/10 text-violet-600 border-violet-500/15 dark:text-violet-400',
}

export interface ThinkingLevelOption {
  value: LumeConfigThinkingLevel
  label: string
  desc: string
  emphasis: string
  tone: PermissionModeTone
}

export const THINKING_LEVEL_OPTIONS: ThinkingLevelOption[] = [
  { value: 'off', label: '关闭', desc: '不使用扩展思考', emphasis: '最快', tone: 'sky' },
  { value: 'low', label: '低', desc: '~1K tokens，轻量推理', emphasis: '快速', tone: 'sky' },
  { value: 'medium', label: '中', desc: '~4K tokens，平衡推理', emphasis: '均衡', tone: 'emerald' },
  { value: 'high', label: '高', desc: '~8K tokens，深度推理', emphasis: '深度', tone: 'violet' },
  { value: 'max', label: '最大', desc: '~16K tokens，极致推理', emphasis: '最强', tone: 'amber' },
]

export const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    value: 'default',
    label: '默认',
    desc: '每次确认高风险操作',
    icon: 'shield',
    tone: 'sky',
    emphasis: '受控',
  },
  {
    value: 'acceptEdits',
    label: '允许编辑',
    desc: '自动接受文件编辑，确认其他操作',
    icon: 'pencil',
    tone: 'emerald',
    emphasis: '高效',
  },
  {
    value: 'dontAsk',
    label: '少询问',
    desc: '自动允许低风险操作，危险操作仍确认',
    icon: 'shield-check',
    tone: 'emerald',
    emphasis: '智能',
  },
  {
    value: 'bypassPermissions',
    label: '全部允许',
    desc: '跳过所有权限确认（谨慎使用）',
    icon: 'shield-off',
    tone: 'amber',
    emphasis: '高风险',
  },
  {
    value: 'plan',
    label: 'Plan 模式',
    desc: '先规划再执行，每步确认',
    icon: 'map',
    tone: 'violet',
    emphasis: '规划',
  },
]

export interface ModelProviderRow {
  provider: ProviderType
  label: string
  channel: Channel | null
  tone: string
  /** 自定义 Channel 的唯一标识（用于区分多个 custom channel） */
  channelId?: string
}

const PROVIDER_TONES: Partial<Record<ProviderType, string>> = {
  openai: 'bg-[#efe9ff] text-[#7a54f2]',
  anthropic: 'bg-[#f5e4b8] text-[#6e5928]',
  google: 'bg-[#e6f0ff] text-[#346df1]',
  deepseek: 'bg-[#e9f1ff] text-[#3a65e5]',
  openrouter: 'bg-[#eff4ff] text-[#111827]',
  custom: 'bg-[#eadcff] text-[#7a52e8]',
  zai: 'bg-[#eee7ff] text-[#7557ff]',
  'zai-coding-plan': 'bg-[#eee7ff] text-[#7557ff]',
  moonshot: 'bg-[#111827] text-white',
  'aliyun-coding-plan': 'bg-[#ff6a00]/10 text-[#ff6a00]',
  'volcengine-coding-plan': 'bg-[#3370ff]/10 text-[#3370ff]',
  'minimax-token-plan': 'bg-[#3d5afe]/10 text-[#3d5afe]',
  'xiaomi-token-plan': 'bg-[#ff6900]/10 text-[#ff6900]',
}

export function buildModelProviderRows(channels: Channel[]): ModelProviderRow[] {
  // 内置 Provider
  const builtInRows = (Object.entries(PROVIDER_LABELS) as [ProviderType, string][])
    .filter(([provider]) => provider !== 'custom')
    .map(([provider, label], index) => ({
      provider,
      label,
      channel: channels.find((channel) => channel.provider === provider) ?? null,
      tone: PROVIDER_TONES[provider] ?? 'bg-[#eef2f7] text-[#4d566f]',
      channelId: undefined as string | undefined,
      index,
    }))

  // 自定义 Channel（每个生成独立行）
  const customRows = channels
    .filter((channel) => channel.provider === 'custom')
    .map((channel, index) => ({
      provider: 'custom' as ProviderType,
      label: channel.name || '自定义供应商',
      channel,
      tone: PROVIDER_TONES['custom'] ?? 'bg-[#eadcff] text-[#7a52e8]',
      channelId: channel.id as string,
      index: builtInRows.length + index,
    }))

  return [...builtInRows, ...customRows]
    .sort((a, b) => {
      const aRank = a.channel?.enabled ? 0 : a.channel ? 1 : 2
      const bRank = b.channel?.enabled ? 0 : b.channel ? 1 : 2
      return aRank - bRank || a.index - b.index
    })
    .map(({ provider, label, channel, tone, channelId }) => ({
      provider, label, channel, tone, channelId,
    }))
}

export function getModelProviderFormInitialValue(
  provider: ProviderType,
  channels: Channel[],
  apiKey: string,
  channelId?: string,
): ChannelCreateInput {
  // 自定义 Channel：通过 channelId 查找
  if (provider === 'custom' && channelId) {
    const existing = channels.find((c) => c.id === channelId)
    if (existing) {
      return {
        name: existing.name,
        provider: existing.provider,
        baseUrl: existing.baseUrl,
        apiKey,
        apiFamily: existing.apiFamily,
        models: existing.models,
        defaultModelId: existing.defaultModelId,
        fallbackModelIds: existing.fallbackModelIds,
        enabled: existing.enabled,
      }
    }
    // 新建自定义 Channel
    return {
      name: '',
      provider: 'custom',
      baseUrl: '',
      apiKey,
      apiFamily: 'openai',
      models: [],
      defaultModelId: undefined,
      fallbackModelIds: undefined,
      enabled: false,
    }
  }
  // 内置 Provider（原有逻辑不变）
  const existing = channels.find((channel) => channel.provider === provider)
  if (!existing) {
    return {
      name: PROVIDER_LABELS[provider],
      provider,
      baseUrl: PROVIDER_DEFAULT_URLS[provider],
      apiKey,
      models: [],
      defaultModelId: undefined,
      fallbackModelIds: undefined,
      enabled: false,
    }
  }
  return {
    name: existing.name,
    provider: existing.provider,
    baseUrl: existing.baseUrl,
    apiKey,
    models: existing.models,
    defaultModelId: existing.defaultModelId,
    fallbackModelIds: existing.fallbackModelIds,
    enabled: existing.enabled,
  }
}
