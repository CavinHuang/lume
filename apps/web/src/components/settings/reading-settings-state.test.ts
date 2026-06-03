import { describe, expect, test } from 'bun:test'
import type { ReadingSettings } from '@lume/shared'
import {
  READING_ADVANCED_STAGE_OPTIONS,
  buildReadingSettingsSavePayload,
  getReadingSettingsDraft,
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
