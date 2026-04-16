import type { ModelInfo } from '../types.js'

const DEFAULT_MODELS: ModelInfo[] = [
  {
    value: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    description: 'Balanced Claude model for most coding and agent tasks.',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-opus-4',
    displayName: 'Claude Opus 4',
    description: 'Higher-capability Claude model for harder tasks.',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    supportsAdaptiveThinking: true,
  },
  {
    value: 'gpt-4o',
    displayName: 'GPT-4o',
    description: 'OpenAI-compatible model via chat completions.',
    supportsEffort: false,
  },
]

export function getDefaultModels(): ModelInfo[] {
  return [...DEFAULT_MODELS]
}

