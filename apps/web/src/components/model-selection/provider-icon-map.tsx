/**
 * Maps ProviderType to @lobehub/icons brand components.
 * Uses direct imports for reliability instead of dynamic ProviderIcon.
 */
import { Cpu } from 'lucide-react'
import {
  Anthropic,
  DeepSeek,
  Doubao,
  Google,
  Minimax,
  Moonshot,
  OpenAI,
  OpenRouter,
  Qwen,
  ZAI,
} from '@lobehub/icons'
import type { ProviderType } from '@lume/shared'
import type { FC, SVGProps } from 'react'

type BrandIcon = FC<SVGProps<SVGSVGElement> & { size?: number; className?: string }>

const PROVIDER_ICON_MAP: Partial<Record<ProviderType, BrandIcon>> = {
  anthropic: Anthropic as BrandIcon,
  'anthropic-compatible': Anthropic as BrandIcon,
  openai: OpenAI as BrandIcon,
  google: Google as BrandIcon,
  deepseek: DeepSeek as BrandIcon,
  openrouter: OpenRouter as BrandIcon,
  minimax: Minimax as BrandIcon,
  'minimax-cn': Minimax as BrandIcon,
  moonshot: Moonshot as BrandIcon,
  zai: ZAI as BrandIcon,
  'zai-coding-plan': ZAI as BrandIcon,
  qwen: Qwen as BrandIcon,
  'qwen-portal': Qwen as BrandIcon,
  doubao: Doubao as BrandIcon,
}

interface ChannelProviderIconProps {
  provider: ProviderType | string
  size?: number
  className?: string
}

export function ChannelProviderIcon({ provider, size = 14, className }: ChannelProviderIconProps) {
  const IconComponent = PROVIDER_ICON_MAP[provider as ProviderType]

  if (IconComponent) {
    return <IconComponent size={size} className={className} />
  }

  return <Cpu size={size} className={className} />
}
