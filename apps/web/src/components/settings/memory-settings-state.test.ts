import { describe, expect, test } from 'bun:test'
import {
  MEMORY_SETTINGS_VIEWS,
  MEMORY_TOOL_POLICY_GROUPS,
  buildMemoryOverviewMetrics,
  candidateStatusLabel,
  formatMemoryBackend,
  isMemoryToolGroupEnabled,
  setMemoryToolGroupEnabled,
  summarizeMemoryResult,
} from './memory-settings-state'

describe('memory settings state', () => {
  test('memory settings views expose workspace/items/global order', () => {
    expect(MEMORY_SETTINGS_VIEWS.map((item) => item.id)).toEqual([
      'workspace',
      'items',
      'global',
    ])
  })

  test('overview metrics summarize status, stats and global candidates', () => {
    expect(buildMemoryOverviewMetrics({
      status: {
        backend: 'builtin',
        provider: 'builtin',
        model: 'lite',
        files: 2,
        chunks: 7,
        ftsEnabled: true,
        vecEnabled: false,
      },
      stats: {
        workspaceSlug: 'demo',
        fileCount: 3,
        chunkCount: 8,
        ftsEnabled: true,
        vecEnabled: false,
      },
      globalStatus: {
        workspaceSlug: '__global__',
        candidateCount: 5,
        pendingCandidateCount: 2,
        itemCount: 1,
      },
    })).toEqual([
      { label: '索引文件', value: '3', tone: 'neutral' },
      { label: '记忆块', value: '8', tone: 'good' },
      { label: 'FTS', value: '已启用', tone: 'good' },
      { label: 'Vector', value: '未启用', tone: 'neutral' },
      { label: '全局候选', value: '2', tone: 'warn' },
    ])
  })

  test('labels keep memory UI compact and localized', () => {
    expect(formatMemoryBackend({ provider: 'builtin', model: 'lite', ftsEnabled: true, vecEnabled: false })).toBe('内置 · builtin')
    expect(candidateStatusLabel('approved')).toBe('已提升')
    expect(summarizeMemoryResult({
      id: 'item-1',
      path: 'MEMORY.md',
      snippet: 'User prefers auditable memory.',
      score: 0.86,
      kind: 'preference',
      scope: 'global',
      source: 'promotion',
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
      'group:memory-maintenance',
      'group:memory-global',
      'group:memory-global-write',
    ])
    expect(isMemoryToolGroupEnabled(config.tools, 'group:memory')).toBe(true)
    expect(setMemoryToolGroupEnabled(config, 'group:memory-write', true).allow).toEqual([
      'group:memory',
      'group:memory-write',
    ])
    expect(setMemoryToolGroupEnabled(config, 'group:memory', false).allow).toEqual([])
  })
})
