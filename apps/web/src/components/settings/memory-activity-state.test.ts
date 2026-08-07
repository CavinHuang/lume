import { describe, expect, test } from 'bun:test'
import { buildMemoryMutationFieldDiffs, MEMORY_MUTATION_ACTION_LABELS, MEMORY_MUTATION_ACTOR_LABELS } from './memory-activity-state'

describe('memory activity presentation', () => {
  test('labels mutation actions and actors for the activity card', () => {
    expect(MEMORY_MUTATION_ACTION_LABELS.updated).toBe('更新记忆')
    expect(MEMORY_MUTATION_ACTOR_LABELS.background_extract).toBe('后台提取')
  })

  test('returns only changed metadata fields', () => {
    const before = {
      id: 'memory-1',
      scope: 'workspace' as const,
      revision: 1,
      statement: '默认使用 Bun',
      status: 'active' as const,
      confidence: 'medium' as const,
      facets: ['runtime'],
      pinned: false,
      activation: { recall: true, persona: true, suggestion: true, analyst: true },
    }
    const after = {
      ...before,
      revision: 2,
      confidence: 'high' as const,
      pinned: true,
    }

    expect(buildMemoryMutationFieldDiffs(before, after)).toEqual([
      { key: 'confidence', label: '置信度', before: '中', after: '高' },
      { key: 'pinned', label: '置顶', before: '否', after: '是' },
    ])
  })

  test('does not invent a before/after diff for legacy current-only details', () => {
    expect(buildMemoryMutationFieldDiffs(undefined, {
      id: 'memory-1',
      scope: 'global',
      revision: 4,
      statement: '默认使用中文',
    })).toEqual([])
  })
})
