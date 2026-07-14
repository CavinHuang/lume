import { describe, expect, test } from 'bun:test'
import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS, type Channel } from '@lume/shared'
import {
  buildModelProviderRows,
  getModelProviderFormInitialValue,
  PERMISSION_OPTIONS,
} from './agent-settings-state'

describe('PERMISSION_OPTIONS', () => {
  test('covers every permission mode with icon and visual tone metadata', () => {
    expect(PERMISSION_OPTIONS).toEqual([
      expect.objectContaining({
        value: 'default',
        icon: 'shield',
        tone: 'sky',
        emphasis: '受控',
      }),
      expect.objectContaining({
        value: 'acceptEdits',
        icon: 'pencil',
        tone: 'emerald',
        emphasis: '高效',
      }),
      expect.objectContaining({
        value: 'dontAsk',
        icon: 'shield-check',
        tone: 'emerald',
        emphasis: '智能',
      }),
      expect.objectContaining({
        value: 'bypassPermissions',
        icon: 'shield-off',
        tone: 'amber',
        emphasis: '高风险',
      }),
      expect.objectContaining({
        value: 'plan',
        icon: 'map',
        tone: 'violet',
        emphasis: '规划',
      }),
    ])
  })
})

describe('model provider settings state', () => {
  test('buildModelProviderRows covers every supported provider from the channel contract', () => {
    const rows = buildModelProviderRows([])

    expect(rows.map((row) => row.provider)).toEqual(Object.keys(PROVIDER_LABELS))
    expect(rows[0]).toEqual(expect.objectContaining({
      provider: 'anthropic',
      label: PROVIDER_LABELS.anthropic,
      channel: null,
    }))
  })

  test('getModelProviderFormInitialValue uses existing channel data with decrypted api key', () => {
    const channel: Channel = {
      id: 'channel-openai',
      name: 'Local OpenAI',
      provider: 'openai',
      baseUrl: 'https://example.local/v1',
      apiKey: 'encrypted',
      models: [{ id: 'gpt-local', name: 'GPT Local', enabled: true }],
      defaultModelId: 'gpt-local',
      fallbackModelIds: ['gpt-fallback'],
      openaiApiMode: 'responses',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    }

    expect(getModelProviderFormInitialValue('openai', [channel], 'sk-local')).toEqual({
      name: 'Local OpenAI',
      provider: 'openai',
      baseUrl: 'https://example.local/v1',
      apiKey: 'sk-local',
      models: channel.models,
      defaultModelId: 'gpt-local',
      fallbackModelIds: ['gpt-fallback'],
      openaiApiMode: 'responses',
      enabled: true,
    })
  })

  test('getModelProviderFormInitialValue uses DeepSeek provider endpoint by default', () => {
    expect(getModelProviderFormInitialValue('deepseek', [], 'sk-deepseek')).toEqual(
      expect.objectContaining({
        name: PROVIDER_LABELS.deepseek,
        provider: 'deepseek',
        baseUrl: PROVIDER_DEFAULT_URLS.deepseek,
        apiKey: 'sk-deepseek',
      })
    )
    expect(PROVIDER_DEFAULT_URLS.deepseek).toBe('https://api.deepseek.com/v1')
  })
})
