import { describe, expect, mock, test } from 'bun:test'
import type { Channel } from '@lume/shared'

mock.module('sonner', () => ({
  toast: {
    error: () => undefined,
    success: () => undefined,
  },
}))
mock.module('@/components/ui/button', () => ({ Button: () => null }))
mock.module('@/components/ui/label', () => ({ Label: () => null }))
mock.module('@/components/model-selection/ModelOptionList', () => ({ ModelOptionList: () => null }))
mock.module('@/lib/model-meta-context', () => ({ useModelMetaVersion: () => 0 }))

const {
  buildFallbackOptionGroups,
  buildStrategySavePayload,
  getDefaultStrategyDraft,
  hasStrategyChanges,
  sanitizeFallbackChain,
} = await import('./DefaultModelStrategyPanel')

const channels: Channel[] = [
  {
    id: 'channel-openai',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'encrypted-openai',
    models: [
      { id: 'gpt-5', name: 'GPT-5', enabled: true, capabilities: { chat: true } },
      { id: 'gpt-5-mini', name: 'GPT-5 mini', enabled: true, capabilities: { chat: true } },
      { id: 'text-embedding-3-small', name: 'Embeddings', enabled: true, capabilities: { embedding: true } },
    ],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'channel-openrouter',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'encrypted-openrouter',
    models: [
      { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', enabled: true, capabilities: { chat: true } },
    ],
    enabled: true,
    createdAt: 2,
    updatedAt: 2,
  },
]

describe('sanitizeFallbackChain', () => {
  test('removes duplicates and the selected default model', () => {
    expect(sanitizeFallbackChain({
      defaultModelRef: 'openai/gpt-5',
      fallbackModelRefs: ['openai/gpt-5', 'openai/gpt-5-mini', 'openai/gpt-5-mini'],
    })).toEqual(['openai/gpt-5-mini'])
  })

  test('trims blank values while preserving order', () => {
    expect(sanitizeFallbackChain({
      defaultModelRef: 'openai/gpt-5',
      fallbackModelRefs: ['  ', ' openai/gpt-5-mini ', 'anthropic/claude-sonnet-4-5'],
    })).toEqual(['openai/gpt-5-mini', 'anthropic/claude-sonnet-4-5'])
  })
})

describe('getDefaultStrategyDraft', () => {
  test('keeps a valid configured channel/model and sanitizes fallbacks', () => {
    expect(getDefaultStrategyDraft({
      channels,
      strategy: {
        defaultChannelId: 'channel-openai',
        defaultModelRef: 'openai/gpt-5',
        fallbackModelRefs: ['openai/gpt-5', 'openai/gpt-5-mini', 'anthropic/claude-sonnet-4-5'],
      },
    })).toEqual({
      defaultModelRef: 'openai/gpt-5',
      fallbackModelRefs: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-4-5'],
      hasExplicitDefaultModel: true,
      unavailableDefaultModelRef: undefined,
      unavailableFallbackModelRefs: [],
    })
  })

  test('keeps a valid provider/model default even when persisted channel metadata is stale', () => {
    expect(getDefaultStrategyDraft({
      channels,
      strategy: {
        defaultChannelId: 'channel-openai',
        defaultModelRef: 'anthropic/claude-sonnet-4-5',
        fallbackModelRefs: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5-mini'],
      },
    })).toEqual({
      defaultModelRef: 'anthropic/claude-sonnet-4-5',
      fallbackModelRefs: ['openai/gpt-5-mini'],
      hasExplicitDefaultModel: true,
      unavailableDefaultModelRef: undefined,
      unavailableFallbackModelRefs: [],
    })
  })

  test('falls back to the first available model when the configured model is unavailable', () => {
    expect(getDefaultStrategyDraft({
      channels,
      strategy: {
        defaultChannelId: 'channel-missing',
        defaultModelRef: 'missing/model',
        fallbackModelRefs: ['missing/model', 'openai/gpt-5-mini'],
      },
    })).toEqual({
      defaultModelRef: 'openai/gpt-5',
      fallbackModelRefs: ['openai/gpt-5-mini'],
      hasExplicitDefaultModel: true,
      unavailableDefaultModelRef: 'missing/model',
      unavailableFallbackModelRefs: [],
    })
  })

  test('keeps empty backend strategy semantics while suggesting editable defaults', () => {
    expect(getDefaultStrategyDraft({
      channels,
      strategy: {},
    })).toEqual({
      defaultModelRef: 'openai/gpt-5',
      fallbackModelRefs: [],
      hasExplicitDefaultModel: false,
      unavailableDefaultModelRef: undefined,
      unavailableFallbackModelRefs: [],
    })
  })
})

describe('buildStrategySavePayload', () => {
  test('returns an empty payload for an untouched empty strategy draft', () => {
    const draft = getDefaultStrategyDraft({
      channels,
      strategy: {},
    })

    expect(buildStrategySavePayload(draft, [
      {
        channelId: 'channel-openai',
        provider: 'openai',
        modelRef: 'openai/gpt-5',
        modelId: 'gpt-5',
        label: 'GPT-5',
        channelLabel: 'OpenAI',
      },
    ])).toEqual({})
  })

  test('derives defaultChannelId from the selected default model', () => {
    const draft = getDefaultStrategyDraft({
      channels,
      strategy: {
        defaultModelRef: 'anthropic/claude-sonnet-4-5',
      },
    })

    expect(buildStrategySavePayload(draft, [
      {
        channelId: 'channel-openai',
        provider: 'openai',
        modelRef: 'openai/gpt-5',
        modelId: 'gpt-5',
        label: 'GPT-5',
        channelLabel: 'OpenAI',
      },
      {
        channelId: 'channel-openrouter',
        provider: 'openrouter',
        modelRef: 'anthropic/claude-sonnet-4-5',
        modelId: 'anthropic/claude-sonnet-4-5',
        label: 'Claude Sonnet 4.5',
        channelLabel: 'OpenRouter',
      },
    ])).toEqual({
      defaultChannelId: 'channel-openrouter',
      defaultModelRef: 'anthropic/claude-sonnet-4-5',
    })
  })
})

describe('buildFallbackOptionGroups', () => {
  test('groups fallback options by channel and marks the active row value', () => {
    expect(buildFallbackOptionGroups([
      {
        channelId: 'channel-openai',
        provider: 'openai',
        modelId: 'gpt-5-mini',
        modelRef: 'openai/gpt-5-mini',
        label: 'GPT-5 mini',
        channelLabel: 'OpenAI',
      },
      {
        channelId: 'channel-openrouter',
        provider: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4-5',
        modelRef: 'anthropic/claude-sonnet-4-5',
        label: 'Claude Sonnet 4.5',
        channelLabel: 'OpenRouter',
      },
    ], 'anthropic/claude-sonnet-4-5')).toEqual([
      {
        id: 'channel-openai',
        label: 'OpenAI',
        provider: 'openai',
        options: [
          {
            channelId: 'channel-openai',
            modelId: 'gpt-5-mini',
            modelRef: 'openai/gpt-5-mini',
            label: 'GPT-5 mini',
            active: false,
          },
        ],
      },
      {
        id: 'channel-openrouter',
        label: 'OpenRouter',
        provider: 'openrouter',
        options: [
          {
            channelId: 'channel-openrouter',
            modelId: 'anthropic/claude-sonnet-4-5',
            modelRef: 'anthropic/claude-sonnet-4-5',
            label: 'Claude Sonnet 4.5',
            active: true,
          },
        ],
      },
    ])
  })
})

describe('hasStrategyChanges', () => {
  test('flags stale persisted values as cleanup work even when the editable draft is sanitized', () => {
    const draft = getDefaultStrategyDraft({
      channels,
      strategy: {
        defaultChannelId: 'channel-missing',
        defaultModelRef: 'missing/model',
        fallbackModelRefs: ['missing/model', 'openai/gpt-5-mini'],
      },
    })

    expect(hasStrategyChanges({
      persistedStrategy: {
        defaultChannelId: 'channel-missing',
        defaultModelRef: 'missing/model',
        fallbackModelRefs: ['missing/model', 'openai/gpt-5-mini'],
      },
      draft,
      allModelOptions: [
        {
          channelId: 'channel-openai',
          provider: 'openai',
          modelRef: 'openai/gpt-5',
          modelId: 'gpt-5',
          label: 'GPT-5',
          channelLabel: 'OpenAI',
        },
        {
          channelId: 'channel-openai',
          provider: 'openai',
          modelRef: 'openai/gpt-5-mini',
          modelId: 'gpt-5-mini',
          label: 'GPT-5 mini',
          channelLabel: 'OpenAI',
        },
        {
          channelId: 'channel-openrouter',
          provider: 'openrouter',
          modelRef: 'anthropic/claude-sonnet-4-5',
          modelId: 'anthropic/claude-sonnet-4-5',
          label: 'Claude Sonnet 4.5',
          channelLabel: 'OpenRouter',
        },
      ],
    })).toBe(true)
  })

  test('does not flag an untouched empty strategy as changed just because edit suggestions are shown', () => {
    const draft = getDefaultStrategyDraft({
      channels,
      strategy: {},
    })

    expect(hasStrategyChanges({
      persistedStrategy: {},
      draft,
      allModelOptions: [
        {
          channelId: 'channel-openai',
          provider: 'openai',
          modelRef: 'openai/gpt-5',
          modelId: 'gpt-5',
          label: 'GPT-5',
          channelLabel: 'OpenAI',
        },
      ],
    })).toBe(false)
  })
})
