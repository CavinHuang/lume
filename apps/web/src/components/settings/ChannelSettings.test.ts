import { describe, expect, test } from 'bun:test'
import type { Channel } from '@lume/shared'
import {
  buildProviderItems,
  getProviderFormInitialValue,
  PROVIDER_LIST_SCROLLAREA_CLASS,
} from './ChannelSettings'

const openAiChannel: Channel = {
  id: 'channel-openai',
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'encrypted-openai',
  models: [{ id: 'gpt-5', name: 'gpt-5', enabled: true }],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
}

describe('buildProviderItems', () => {
  test('lists every provider and marks configured providers', () => {
    const items = buildProviderItems([openAiChannel])

    expect(items.some((item) => item.provider === 'openai' && item.channel?.id === 'channel-openai')).toBe(true)
    expect(items.some((item) => item.provider === 'anthropic' && item.channel === null)).toBe(true)
    expect(items.some((item) => item.provider === 'anthropic-compatible' && item.channel === null)).toBe(true)
    expect(items.length).toBeGreaterThan(5)
  })

  test('puts enabled providers at the top', () => {
    const disabledAnthropic: Channel = {
      id: 'channel-anthropic',
      name: 'Anthropic',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'encrypted-anthropic',
      models: [{ id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5', enabled: true }],
      enabled: false,
      createdAt: 2,
      updatedAt: 2,
    }

    const items = buildProviderItems([disabledAnthropic, openAiChannel])

    expect(items[0]?.provider).toBe('openai')
    expect(items[1]?.provider).toBe('anthropic')
  })
})

describe('getProviderFormInitialValue', () => {
  test('uses existing channel values when provider is configured', () => {
    expect(getProviderFormInitialValue('openai', [openAiChannel], 'plain-key')).toEqual({
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'plain-key',
      models: [{ id: 'gpt-5', name: 'gpt-5', enabled: true }],
      defaultModelId: undefined,
      fallbackModelIds: undefined,
      enabled: true,
    })
  })

  test('creates a disabled blank shell for an unconfigured provider', () => {
    expect(getProviderFormInitialValue('anthropic-compatible', [openAiChannel], '')).toEqual({
      name: 'Anthropic 兼容模式',
      provider: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      models: [],
      defaultModelId: undefined,
      fallbackModelIds: undefined,
      enabled: false,
    })
  })
})

describe('PROVIDER_LIST_SCROLLAREA_CLASS', () => {
  test('uses container-driven height instead of viewport calc', () => {
    expect(PROVIDER_LIST_SCROLLAREA_CLASS).toContain('h-full')
    expect(PROVIDER_LIST_SCROLLAREA_CLASS).toContain('min-h-0')
    expect(PROVIDER_LIST_SCROLLAREA_CLASS.includes('calc(100vh')).toBe(false)
  })
})
