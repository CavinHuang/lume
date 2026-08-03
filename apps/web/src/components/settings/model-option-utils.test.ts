import { describe, expect, test } from 'bun:test'
import type { Channel } from '@lume/shared'
import { buildModelOptions, getEnabledChannels, isConnectionReady } from './model-option-utils'

function channel(input: Partial<Channel> = {}): Channel {
  return {
    id: 'connection-1',
    name: 'Connection',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    authType: 'api-key',
    hasApiKey: true,
    models: [{ id: 'gpt-test', name: 'GPT Test', enabled: true, capabilities: { chat: true } }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  }
}

describe('model option connection readiness', () => {
  test('keeps missing OAuth and API-key credentials out of model selectors', () => {
    const missingOAuth = channel({ id: 'oauth', authType: 'oauth', hasApiKey: false, hasOAuthCredential: false })
    const missingApiKey = channel({ id: 'api-key', authType: 'api-key', hasApiKey: false })
    const readyOAuth = channel({ id: 'oauth-ready', authType: 'oauth', hasApiKey: false, hasOAuthCredential: true })

    expect(isConnectionReady(missingOAuth)).toBe(false)
    expect(isConnectionReady(missingApiKey)).toBe(false)
    expect(getEnabledChannels([missingOAuth, missingApiKey, readyOAuth]).map((item) => item.id)).toEqual(['oauth-ready'])
    expect(buildModelOptions(getEnabledChannels([missingOAuth, readyOAuth]))).toHaveLength(1)
  })

  test('allows explicitly supported local no-auth connections', () => {
    expect(isConnectionReady(channel({ provider: 'ollama', authType: 'none', hasApiKey: false }))).toBe(true)
    expect(isConnectionReady(channel({ provider: 'custom', authType: 'none', hasApiKey: false }))).toBe(false)
  })
})
