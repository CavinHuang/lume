import { describe, expect, test } from 'bun:test'
import {
  MEMORY_SETTINGS_VIEWS,
  MEMORY_TOOL_POLICY_GROUPS,
  isMemoryToolGroupEnabled,
  setMemoryToolGroupEnabled,
  summarizeMemoryResult,
} from './memory-settings-state'

describe('memory settings state', () => {
  test('memory settings views expose V2-only order', () => {
    expect(MEMORY_SETTINGS_VIEWS.map((item) => item.id)).toEqual([
      'workspace',
      'items',
    ])
  })

  test('labels keep memory UI compact and localized', () => {
    expect(summarizeMemoryResult({
      id: 'item-1',
      path: 'MEMORY.md',
      snippet: 'User prefers auditable memory.',
      score: 0.86,
      kind: 'preference',
      scope: 'global',
      source: 'memory',
    })).toBe('全局 · 偏好 · 86%')
  })

  test('memory tool policy group helpers toggle allow entries', () => {
    const config = {
      version: 1,
      tools: { allow: ['group:memory'] },
      citations: 'auto' as const,
      sources: ['memory' as const],
      extraPaths: [],
    }

    expect(MEMORY_TOOL_POLICY_GROUPS.map((group) => group.id)).toEqual([
      'group:memory',
      'group:memory-write',
    ])
    expect(isMemoryToolGroupEnabled(config.tools, 'group:memory')).toBe(true)
    expect(setMemoryToolGroupEnabled(config, 'group:memory-write', true).allow).toEqual([
      'group:memory',
      'group:memory-write',
    ])
    expect(setMemoryToolGroupEnabled(config, 'group:memory', false).allow).toEqual([])
  })
})
