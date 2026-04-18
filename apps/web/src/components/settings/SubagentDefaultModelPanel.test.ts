import { describe, expect, test } from 'bun:test'
import type { Channel } from '@lume/shared'
import {
  buildSubagentDefaultModelPayload,
  getSubagentDefaultModelDraft,
} from './subagent-default-model-state'

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

describe('getSubagentDefaultModelDraft', () => {
  test('keeps a valid configured model', () => {
    expect(getSubagentDefaultModelDraft({
      channels,
      strategy: { defaultModelRef: 'anthropic/claude-sonnet-4-5' },
    })).toEqual({
      defaultModelRef: 'anthropic/claude-sonnet-4-5',
      hasExplicitDefaultModel: true,
      unavailableDefaultModelRef: undefined,
    })
  })

  test('falls back to inherit when the configured model is unavailable', () => {
    expect(getSubagentDefaultModelDraft({
      channels,
      strategy: { defaultModelRef: 'missing/model' },
    })).toEqual({
      defaultModelRef: undefined,
      hasExplicitDefaultModel: true,
      unavailableDefaultModelRef: 'missing/model',
    })
  })

  test('treats empty config as inherit-current-conversation', () => {
    expect(getSubagentDefaultModelDraft({
      channels,
      strategy: {},
    })).toEqual({
      defaultModelRef: undefined,
      hasExplicitDefaultModel: false,
      unavailableDefaultModelRef: undefined,
    })
  })
})

describe('buildSubagentDefaultModelPayload', () => {
  test('persists an explicit model selection', () => {
    expect(buildSubagentDefaultModelPayload({
      defaultModelRef: 'openai/gpt-5-mini',
      hasExplicitDefaultModel: true,
    })).toEqual({
      defaultModelRef: 'openai/gpt-5-mini',
    })
  })

  test('emits an empty object for inherit-current-conversation mode', () => {
    expect(buildSubagentDefaultModelPayload({
      defaultModelRef: undefined,
      hasExplicitDefaultModel: false,
    })).toEqual({})
  })
})
