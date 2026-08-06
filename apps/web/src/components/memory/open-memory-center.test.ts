import { describe, expect, test } from 'bun:test'
import type { Tab } from '@/atoms/tab-atoms'
import {
  MEMORY_CENTER_TAB_ID,
  memoryCenterTarget,
  upsertMemoryCenterTab,
} from './open-memory-center'

describe('open memory center', () => {
  test('adds the compatibility tab without replacing existing tabs', () => {
    const tabs: Tab[] = [{ id: 'thread-1', type: 'agent', title: '会话' }]
    expect(upsertMemoryCenterTab(tabs)).toEqual([
      tabs[0],
      { id: MEMORY_CENTER_TAB_ID, type: 'proactive', title: '记忆与洞察' },
    ])
  })

  test('reuses and renames a restored proactive tab', () => {
    const tabs: Tab[] = [{ id: MEMORY_CENTER_TAB_ID, type: 'proactive', title: '主动' }]
    expect(upsertMemoryCenterTab(tabs)).toEqual([
      { id: MEMORY_CENTER_TAB_ID, type: 'proactive', title: '记忆与洞察' },
    ])
  })

  test('preserves a job target and defaults to attention', () => {
    const target = { section: 'activity' as const, jobId: 'job-1' }
    expect(memoryCenterTarget(target)).toBe(target)
    expect(memoryCenterTarget()).toEqual({ section: 'attention' })
  })
})
