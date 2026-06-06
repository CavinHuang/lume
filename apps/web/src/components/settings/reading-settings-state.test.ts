import { describe, expect, test } from 'bun:test'
import type { Channel, ReadingSettings } from '@lume/shared'
import {
  READING_ADVANCED_STAGE_OPTIONS,
  applyReadingModelSelectChange,
  buildReadingChatModelOptions,
  buildReadingSettingsSavePayload,
  getReadingSettingsDraft,
  resolveReadingModelSelectValue,
} from './reading-settings-state'

describe('reading settings state', () => {
  test('normalizes cadence and quiet defaults for the settings draft', () => {
    expect(getReadingSettingsDraft(createSettings({ cadence: 'weekly' }))).toMatchObject({
      cadence: 'weekly',
      quiet: true,
      maxDeepNotesPerWeek: 1,
    })
  })

  test('supports inherit-current-chat and explicit Reading model refs', () => {
    expect(buildReadingSettingsSavePayload({
      cadence: 'few_times_weekly',
      quiet: true,
      maxDeepNotesPerWeek: 1,
      textModelMode: 'inherit',
      textModelRef: ' openai/gpt-5 ',
      imageModelRef: '',
      advanced: {},
    })).toMatchObject({
      textModelMode: 'inherit',
      textModelRef: null,
      imageModelRef: null,
    })

    expect(buildReadingSettingsSavePayload({
      cadence: 'weekly',
      quiet: true,
      maxDeepNotesPerWeek: 1,
      textModelMode: 'explicit',
      textModelRef: ' openai/gpt-5-mini ',
      imageModelRef: ' openai/gpt-image ',
      advanced: {
        deepModelRef: ' anthropic/claude-sonnet-4-5 '
      },
    })).toMatchObject({
      textModelMode: 'explicit',
      textModelRef: 'openai/gpt-5-mini',
      imageModelRef: 'openai/gpt-image',
      advanced: {
        deepModelRef: 'anthropic/claude-sonnet-4-5'
      },
    })
  })

  test('keeps advanced Reading stages explicit and compact', () => {
    expect(READING_ADVANCED_STAGE_OPTIONS.map((item) => item.id)).toEqual([
      'selectionModelRef',
      'seedModelRef',
      'deepModelRef',
      'companionModelRef',
    ])
  })

  test('builds chat model options from channels with inherit first', () => {
    const channels: Channel[] = [
      {
        id: 'ch-1',
        name: 'ZAI',
        provider: 'zai',
        baseUrl: 'https://api.zai.com',
        apiKey: '',
        enabled: true,
        models: [
          { id: 'glm-5.1', name: 'GLM-5.1', enabled: true, capabilities: { chat: true } },
          { id: 'glm-5-mini', name: 'GLM-5-mini', enabled: true, capabilities: { chat: true } },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'ch-2',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        enabled: false,
        models: [
          { id: 'gpt-5', name: 'GPT-5', enabled: true, capabilities: { chat: true } },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    const options = buildReadingChatModelOptions(channels)
    expect(options).toHaveLength(3)
    expect(options[0]).toEqual({ modelRef: '', label: '继承默认模型' })
    expect(options[1]).toEqual({ modelRef: 'zai/glm-5.1', label: 'GLM-5.1 · ZAI' })
    expect(options[2]).toEqual({ modelRef: 'zai/glm-5-mini', label: 'GLM-5-mini · ZAI' })
  })

  test('resolves dropdown value from draft mode', () => {
    const inheritDraft = getReadingSettingsDraft(createSettings({ textModelMode: 'inherit' }))
    expect(resolveReadingModelSelectValue(inheritDraft)).toBe('')

    const explicitDraft = getReadingSettingsDraft(createSettings({
      textModelMode: 'explicit',
      textModelRef: 'zai/glm-5.1',
    }))
    expect(resolveReadingModelSelectValue(explicitDraft)).toBe('zai/glm-5.1')
  })

  test('applies model select change to draft', () => {
    const draft = getReadingSettingsDraft(createSettings())
    const inherited = applyReadingModelSelectChange(draft, '')
    expect(inherited.textModelMode).toBe('inherit')
    expect(inherited.textModelRef).toBe('')

    const explicit = applyReadingModelSelectChange(draft, 'zai/glm-5.1')
    expect(explicit.textModelMode).toBe('explicit')
    expect(explicit.textModelRef).toBe('zai/glm-5.1')
  })
})

function createSettings(overrides: Partial<ReadingSettings> = {}): ReadingSettings {
  return {
    version: 1,
    language: 'zh',
    cadence: 'weekly',
    quiet: true,
    maxDeepNotesPerWeek: 1,
    textModelMode: 'inherit',
    advanced: {},
    weread: { apiKeySet: false },
    updatedAt: 1,
    ...overrides,
  }
}
