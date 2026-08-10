import { describe, expect, mock, test } from 'bun:test'
import type { MemorySettingsEntrySummary, MemorySettingsSnapshot } from '@lume/shared'
import { loadMemoryCenterSnapshot, rankMemoryCenterEntries } from './use-memory-center'

describe('useMemoryCenter helpers', () => {
  test('使用当前工作区加载完整中心快照', async () => {
    const snapshot = { workspaceSlug: 'workspace-a' } as MemorySettingsSnapshot
    const loader = mock(async (workspaceSlug: string) => {
      expect(workspaceSlug).toBe('workspace-a')
      return snapshot
    })

    await expect(loadMemoryCenterSnapshot('workspace-a', loader)).resolves.toBe(snapshot)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  test('最近变更条目优先，同时保留未出现在活动中的条目', () => {
    const first = { id: 'first' } as MemorySettingsEntrySummary
    const second = { id: 'second' } as MemorySettingsEntrySummary
    const third = { id: 'third' } as MemorySettingsEntrySummary
    const snapshot = {
      globalEntries: [first],
      workspaceEntries: [second, third],
      activity: [{ memoryIds: ['third', 'first'] }],
    } as MemorySettingsSnapshot

    expect(rankMemoryCenterEntries(snapshot).map((entry) => entry.id)).toEqual(['third', 'first', 'second'])
    expect(rankMemoryCenterEntries(null)).toEqual([])
  })
})
