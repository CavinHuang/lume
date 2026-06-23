import { describe, expect, test } from 'bun:test'
import type { AutomationRun } from '@lume/shared'
import { formatRunTime, buildAutomationRunReplayTab, openAutomationRunReplay } from './automation-run-replay'

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    jobId: 'job-1',
    jobName: '每晚报告',
    threadId: 'thread-1',
    trigger: 'schedule',
    status: 'success',
    message: '',
    startedAt: new Date('2026-01-02T03:04:56').getTime(),
    finishedAt: new Date('2026-01-02T03:05:00').getTime(),
    ...overrides,
  }
}

describe('formatRunTime', () => {
  test('formats a timestamp as MM-DD HH:mm in local time', () => {
    // 输入为本地时间字符串（无 Z），输出也取本地分量，故与时区无关、稳定
    const ts = new Date('2026-03-04T05:06:00').getTime()
    expect(formatRunTime(ts)).toBe('03-04 05:06')
  })
})

describe('buildAutomationRunReplayTab', () => {
  test('builds a read-only agent tab keyed by threadId with composed title', () => {
    expect(buildAutomationRunReplayTab(makeRun())).toEqual({
      id: 'thread-1',
      type: 'agent',
      title: '自动化·每晚报告 · 01-02 03:04',
      threadId: 'thread-1',
      readOnly: true,
    })
  })

  test('returns null when the run has no threadId', () => {
    expect(buildAutomationRunReplayTab(makeRun({ threadId: undefined }))).toBeNull()
  })
})

describe('openAutomationRunReplay', () => {
  test('upserts the read-only tab and returns its id as active', () => {
    const existing = [{ id: 'other', type: 'agent' as const, title: '其它', threadId: 'other' }]
    const result = openAutomationRunReplay(makeRun(), existing)
    expect(result?.activeTabId).toBe('thread-1')
    expect(result?.tabs).toHaveLength(2)
    expect(result?.tabs.find((t) => t.id === 'thread-1')).toMatchObject({ readOnly: true })
  })

  test('dedupes by threadId (upserts in place instead of appending)', () => {
    const existing = [{ id: 'thread-1', type: 'agent' as const, title: '旧标题', threadId: 'thread-1' }]
    const result = openAutomationRunReplay(makeRun(), existing)
    expect(result?.tabs).toHaveLength(1)
    expect(result?.tabs[0]).toMatchObject({
      title: '自动化·每晚报告 · 01-02 03:04',
      readOnly: true,
    })
  })

  test('returns null (no-op) when the run has no threadId', () => {
    expect(openAutomationRunReplay(makeRun({ threadId: undefined }), [])).toBeNull()
  })
})
