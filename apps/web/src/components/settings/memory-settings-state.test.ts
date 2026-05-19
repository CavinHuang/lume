import { describe, expect, test } from 'bun:test'
import {
  MEMORY_SETTINGS_VIEWS,
  MEMORY_TOOL_POLICY_GROUPS,
  buildMemoryOverviewMetrics,
  isMemoryToolGroupEnabled,
  pendingNotice,
  setMemoryToolGroupEnabled,
  summarizeMemoryEntry,
} from './memory-settings-state'

describe('memory settings state', () => {
  test('memory settings views expose V2-only order', () => {
    expect(MEMORY_SETTINGS_VIEWS.map((item) => item.id)).toEqual([
      'overview',
      'workspace',
      'global',
      'pending',
    ])
  })

  test('overview metrics and pending notice stay quiet until action is needed', () => {
    const metrics = buildMemoryOverviewMetrics({
      workspaceSlug: 'demo',
      counts: {
        active: 3,
        workspace: 2,
        global: 1,
        suspectedStale: 1,
        pinned: 1,
        daily: 4,
        runs: 2,
        pending: {
          conflicts: 1,
          stale: 1,
          lowConfidence: 0,
          total: 2,
        },
      },
      files: [],
      workspaceEntries: [],
      globalEntries: [],
      pending: [],
    })

    expect(metrics.map((item) => item.value)).toEqual(['3', '2', '1', '1', '2'])
    expect(metrics.at(-1)?.tone).toBe('warn')
    expect(pendingNotice({
      conflicts: 1,
      stale: 1,
      lowConfidence: 0,
      total: 2,
    })).toBe('1 个冲突 · 1 个可能过期')
    expect(pendingNotice()).toBe('无待处理记忆')
  })

  test('labels keep memory UI compact and localized', () => {
    expect(summarizeMemoryEntry({
      id: 'mem-1',
      path: 'MEMORY.md',
      scope: 'workspace',
      kind: 'decision',
      status: 'suspected_stale',
      confidence: 'medium',
      statement: 'Use Memory V2.',
      updated: '2026-05-19T00:00:00.000Z',
      pinned: false,
      tags: [],
    })).toBe('工作区 · 决策 · 可能过期')
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
