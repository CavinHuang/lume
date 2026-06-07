import { describe, expect, test } from 'bun:test'
import {
  getSkillAllowedToolOptions,
  getSystemToolDefinitionValues,
  SKILL_TOOL_DEFINITIONS,
} from './skill-tool-definitions'

describe('skill-tool-definitions', () => {
  test('keeps every skill editor tool option attached to a system tool group', () => {
    const options = getSkillAllowedToolOptions()

    expect(options.map((option) => option.value)).toEqual([
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'list_dir',
      'web_search',
      'web_fetch',
      'personalize_ui',
      'lume_reading_snapshot',
      'lume_generate_share_card',
      'office_validate',
      'office_unpack',
      'agent_spawn',
    ])
    expect(options.every((option) => Boolean(option.systemGroupId))).toBe(true)
    expect(options.find((option) => option.value === 'agent_spawn')?.disabled).toBe(true)
  })

  test('derives system group tool previews from the same definitions', () => {
    expect(getSystemToolDefinitionValues('shell')).toEqual(['bash'])
    expect(getSystemToolDefinitionValues('file-write')).toEqual(['write_file', 'edit_file'])
    expect(getSystemToolDefinitionValues('web')).toEqual(['web_search', 'web_fetch'])
    expect(getSystemToolDefinitionValues('evolution')).toEqual(['personalize_ui'])
    expect(getSystemToolDefinitionValues('reading')).toEqual([
      'lume_reading_snapshot',
      'lume_generate_share_card',
    ])
    expect(getSystemToolDefinitionValues('office')).toEqual(['office_validate', 'office_unpack'])
  })

  test('does not duplicate tool values', () => {
    const values = SKILL_TOOL_DEFINITIONS.map((definition) => definition.value)
    expect(new Set(values).size).toBe(values.length)
  })
})
