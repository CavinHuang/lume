/**
 * Maps ProviderType to @lobehub/icons provider names.
 * Falls back to a generic Cpu icon for unknown providers.
 */
import { Cpu } from 'lucide-react'
import { ProviderIcon } from '@lobehub/icons'
import type { ProviderType } from '@lume/shared'

const PROVIDER_ICON_MAP: Partial<Record<ProviderType, string>> = {
  anthropic: 'anthropic',
  'anthropic-compatible': 'anthropic',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  moonshot: 'moonshot',
  zhipu: 'zhipu',
  zai: 'zhipu',
  qwen: 'qwen',
  'qwen-portal': 'qwen',
  doubao: 'doubao',
}

interface ChannelProviderIconProps {
  provider: ProviderType
  size?: number
  className?: string
}

export function ChannelProviderIcon({ provider, size = 14, className }: ChannelProviderIconProps) {
  const iconProvider = PROVIDER_ICON_MAP[provider]

  if (iconProvider) {
    return <ProviderIcon provider={iconProvider} size={size} type="avatar" shape="square" className={className} />
  }

  return <Cpu size={size} className={className} />
}

export function getProviderIconName(provider: ProviderType): string | null {
  return PROVIDER_ICON_MAP[provider] ?? null
}
