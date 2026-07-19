import { describe, expect, test } from 'bun:test'
import {
  LumeCapabilityReferenceError,
  formatLumePluginReference,
  formatLumeSkillReference,
  normalizeLumeCapabilityReferences,
  parseLumeCapabilityReference,
} from './capability-references.js'

describe('Lume capability references', () => {
  test('formats and parses canonical plugin, skill, and plugin-skill references', () => {
    expect(formatLumePluginReference('browser')).toBe('lume-plugin://browser')
    expect(formatLumeSkillReference('review')).toBe('lume-skill://review')
    expect(formatLumeSkillReference('inspect', 'browser')).toBe('lume-skill://browser:inspect')

    expect(parseLumeCapabilityReference('lume-plugin://Browser')).toEqual({
      kind: 'plugin',
      uri: 'lume-plugin://Browser',
      pluginId: 'Browser',
    })
    expect(parseLumeCapabilityReference('lume-skill://browser:inspect')).toEqual({
      kind: 'skill',
      uri: 'lume-skill://browser:inspect',
      pluginId: 'browser',
      skillSlug: 'inspect',
    })
  })

  test('encodes reserved and unicode identifier content without URL authority normalization', () => {
    const uri = formatLumeSkillReference('检查:结果', '@scope/browser')
    expect(uri).toBe('lume-skill://%40scope%2Fbrowser:%E6%A3%80%E6%9F%A5%3A%E7%BB%93%E6%9E%9C')
    expect(parseLumeCapabilityReference(uri)).toMatchObject({
      pluginId: '@scope/browser',
      skillSlug: '检查:结果',
    })
  })

  test('rejects malformed or non-canonical encodings', () => {
    for (const uri of [
      'lume-plugin://',
      'lume-skill://plugin:',
      'lume-skill://:skill',
      'lume-plugin://has space',
      'lume-plugin://%2f',
      'lume-plugin://é',
    ]) {
      expect(() => parseLumeCapabilityReference(uri)).toThrow(LumeCapabilityReferenceError)
    }
    expect(parseLumeCapabilityReference('https://example.com')).toBeNull()
    expect(parseLumeCapabilityReference('lume-plugin://%252F')).toMatchObject({
      pluginId: '%2F',
    })
  })

  test('deduplicates references and lets a whole-plugin reference cover plugin skills', () => {
    expect(normalizeLumeCapabilityReferences([
      'lume-skill://browser:inspect',
      'lume-skill://review',
      'lume-plugin://browser',
      'lume-skill://browser:other',
      'lume-skill://review',
    ]).map((reference) => reference.uri)).toEqual([
      'lume-skill://review',
      'lume-plugin://browser',
    ])
  })
})
