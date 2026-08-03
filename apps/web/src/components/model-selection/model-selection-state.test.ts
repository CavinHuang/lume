import { describe, expect, test } from 'bun:test'
import type { AgentThreadMeta, Channel } from '@lume/shared'
import {
  buildModelSelectionGroups,
  getThreadSelectionSummary,
} from './model-selection-state'

const channels: Channel[] = [
  {
    id: 'channel-openai',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'encrypted-openai',
    models: [
      { id: 'gpt-5', name: 'GPT-5', enabled: true },
      { id: 'gpt-5-mini', name: 'GPT-5 mini', enabled: true },
      { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini', enabled: true },
      { id: 'text-embedding-3-small', name: 'Embeddings', enabled: true, capabilities: { chat: false, embedding: true } },
    ],
    defaultModelId: 'gpt-5',
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
      { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', enabled: true },
    ],
    enabled: true,
    createdAt: 2,
    updatedAt: 2,
  },
]

describe('buildModelSelectionGroups', () => {
  test('groups enabled models by channel and marks the active option', () => {
    const result = buildModelSelectionGroups({
      channels,
      activeChannelId: 'channel-openai',
      activeModelRef: 'openai/gpt-5',
    })

    expect(result[0]).toEqual({
      id: 'channel-openai',
      label: 'OpenAI',
      provider: 'openai',
      options: [
        {
          channelId: 'channel-openai',
          modelId: 'gpt-5',
          modelRef: 'connection:channel-openai/gpt-5',
          label: 'GPT-5',
          active: true,
          meta: expect.objectContaining({
            id: 'gpt-5',
            displayName: 'GPT-5',
          }),
          inferredCapabilities: undefined,
        },
        {
          channelId: 'channel-openai',
          modelId: 'gpt-5-mini',
          modelRef: 'connection:channel-openai/gpt-5-mini',
          label: 'GPT-5 mini',
          active: false,
          meta: expect.objectContaining({
            id: 'gpt-5-mini',
            displayName: 'GPT-5 Mini',
          }),
          inferredCapabilities: undefined,
        },
        {
          channelId: 'channel-openai',
          modelId: 'openai/gpt-4.1-mini',
          modelRef: 'connection:channel-openai/openai/gpt-4.1-mini',
          label: 'GPT-4.1 mini',
          active: false,
          meta: expect.objectContaining({
            id: 'gpt-4.1-mini',
            displayName: 'GPT-4.1 mini',
            contextWindow: 1_047_576,
          }),
          inferredCapabilities: undefined,
        },
      ],
    })
  })

  test('keeps provider-prefixed IDs opaque inside connection-scoped refs', () => {
    const result = buildModelSelectionGroups({
      channels,
      activeChannelId: 'channel-openrouter',
      activeModelRef: 'anthropic/claude-sonnet-4-5',
    })

    expect(result[0]?.options[2]).toEqual({
      channelId: 'channel-openai',
      modelId: 'openai/gpt-4.1-mini',
      modelRef: 'connection:channel-openai/openai/gpt-4.1-mini',
      label: 'GPT-4.1 mini',
      active: false,
      meta: expect.objectContaining({
        id: 'gpt-4.1-mini',
        displayName: 'GPT-4.1 mini',
        contextWindow: 1_047_576,
      }),
      inferredCapabilities: undefined,
    })
    expect(result[1]?.options[0]).toEqual({
      channelId: 'channel-openrouter',
      modelId: 'anthropic/claude-sonnet-4-5',
      modelRef: 'connection:channel-openrouter/anthropic/claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      active: true,
      meta: expect.objectContaining({
        id: 'claude-sonnet-4-20250514',
        displayName: 'Claude Sonnet 4',
      }),
      inferredCapabilities: undefined,
    })
  })
})

describe('getThreadSelectionSummary', () => {
  test('summarizes inherited thread state with the effective label', () => {
    const thread: AgentThreadMeta = {
      id: 'thread-1',
      title: 'Thread',
      channelId: 'channel-openai',
      modelRef: 'openai/gpt-5',
      modelSelectionSource: 'inherited',
      createdAt: 1,
      updatedAt: 1,
    }

    expect(getThreadSelectionSummary({ channels, channelsLoaded: true, thread })).toEqual(expect.objectContaining({
      label: 'GPT-5',
      hasLoadedChannels: true,
      isOverride: false,
      isUnavailable: false,
      meta: expect.objectContaining({ id: 'gpt-5' }),
    }))
  })

  test('summarizes override state and keeps the lightweight override badge flag', () => {
    const thread: AgentThreadMeta = {
      id: 'thread-2',
      title: 'Thread',
      channelId: 'channel-openai',
      modelRef: 'openai/gpt-5-mini',
      modelSelectionSource: 'thread-override',
      createdAt: 1,
      updatedAt: 1,
    }

    expect(getThreadSelectionSummary({ channels, channelsLoaded: true, thread })).toEqual(expect.objectContaining({
      label: 'GPT-5 mini',
      hasLoadedChannels: true,
      isOverride: true,
      isUnavailable: false,
      meta: expect.objectContaining({ id: 'gpt-5-mini' }),
    }))
  })

  test('marks an unavailable override when the current selection no longer exists', () => {
    const thread: AgentThreadMeta = {
      id: 'thread-3',
      title: 'Thread',
      channelId: 'channel-openai',
      modelRef: 'openai/gpt-4.1',
      modelSelectionSource: 'thread-override',
      createdAt: 1,
      updatedAt: 1,
    }

    expect(getThreadSelectionSummary({ channels, channelsLoaded: true, thread })).toEqual({
      label: 'openai/gpt-4.1',
      hasLoadedChannels: true,
      isOverride: true,
      isUnavailable: true,
    })
  })

  test('does not mark the selection unavailable before channels are loaded', () => {
    const thread: AgentThreadMeta = {
      id: 'thread-loading',
      title: 'Thread',
      channelId: 'channel-openai',
      modelRef: 'openai/gpt-5',
      modelSelectionSource: 'thread-override',
      createdAt: 1,
      updatedAt: 1,
    }

    expect(getThreadSelectionSummary({ channels: [], channelsLoaded: false, thread })).toEqual({
      label: 'openai/gpt-5',
      hasLoadedChannels: false,
      isOverride: true,
      isUnavailable: false,
    })
  })

  test('marks a stale selection unavailable after an explicit loaded-empty result', () => {
    const thread: AgentThreadMeta = {
      id: 'thread-loaded-empty',
      title: 'Thread',
      channelId: 'channel-openai',
      modelRef: 'openai/gpt-5',
      modelSelectionSource: 'thread-override',
      createdAt: 1,
      updatedAt: 1,
    }

    expect(getThreadSelectionSummary({ channels: [], channelsLoaded: true, thread })).toEqual({
      label: 'openai/gpt-5',
      hasLoadedChannels: true,
      isOverride: true,
      isUnavailable: true,
    })
  })

  test('returns an empty label when there is no current selection', () => {
    const thread: AgentThreadMeta = {
      id: 'thread-4',
      title: 'Thread',
      modelSelectionSource: 'inherited',
      createdAt: 1,
      updatedAt: 1,
    }

    expect(getThreadSelectionSummary({ channels: [], channelsLoaded: false, thread })).toEqual({
      label: '',
      hasLoadedChannels: false,
      isOverride: false,
      isUnavailable: false,
    })
  })
})

describe('buildModelSelectionGroups with metadata', () => {
  test('augments each option with matching ModelMeta', () => {
    const result = buildModelSelectionGroups({
      channels,
      activeChannelId: 'channel-openai',
      activeModelRef: 'openai/gpt-5',
    })

    expect(result[0].options[0].meta).toEqual(expect.objectContaining({
      id: 'gpt-5',
      displayName: 'GPT-5',
    }))

    // claude-sonnet-4-5 should match via the model-meta registry
    const openrouterGroup = result[1]
    expect(openrouterGroup.options[0].meta).toBeDefined()
    expect(openrouterGroup.options[0].meta!.displayName).toBe('Claude Sonnet 4')
  })

  test('augments groups with provider field', () => {
    const result = buildModelSelectionGroups({
      channels,
      activeChannelId: 'channel-openai',
      activeModelRef: 'openai/gpt-5',
    })

    expect(result[0].provider).toBe('openai')
    expect(result[1].provider).toBe('openrouter')
  })
})

describe('model selection connection readiness', () => {
  test('hides models and marks the selection unavailable when OAuth credentials are missing', () => {
    const missingCredential: Channel = {
      ...channels[0],
      apiKey: '',
      authType: 'oauth',
      hasApiKey: false,
      hasOAuthCredential: false,
    }

    expect(buildModelSelectionGroups({ channels: [missingCredential] })).toEqual([])
    expect(getThreadSelectionSummary({
      channels: [missingCredential],
      channelsLoaded: true,
      thread: {
        id: 'thread-missing-oauth',
        title: 'Thread',
        channelId: missingCredential.id,
        modelRef: `connection:${missingCredential.id}/gpt-5`,
        modelSelectionSource: 'thread-override',
        createdAt: 1,
        updatedAt: 1,
      },
    })).toMatchObject({ isUnavailable: true })
  })
})
