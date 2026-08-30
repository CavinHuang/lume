import { describe, expect, test } from 'bun:test'
import { buildFileTab, buildThreadPlanFileTab, upsertTab } from './file-tabs'
import type { Tab } from '@/atoms'

describe('file-tabs', () => {
  test('buildFileTab uses basename as title and keeps local tabs stable by sourcePath', () => {
    const tab = buildFileTab({
      filePath: 'docs/release/desktop-release.md',
      fileSource: 'local',
      sourcePath: '/tmp/docs/release/desktop-release.md',
    })

    expect(tab.title).toBe('desktop-release.md')
    expect(tab.id).toBe('file:local:/tmp/docs/release/desktop-release.md')
  })

  test('upsertTab replaces an existing tab in place', () => {
    const tabs: Tab[] = [
      { id: 'a', type: 'welcome', title: '新会话' },
      { id: 'b', type: 'file', title: 'old.md', filePath: 'old.md', fileSource: 'workspace' },
    ]

    expect(upsertTab(tabs, { id: 'b', type: 'file', title: 'new.md', filePath: 'new.md', fileSource: 'workspace' })).toEqual([
      tabs[0],
      { id: 'b', type: 'file', title: 'new.md', filePath: 'new.md', fileSource: 'workspace' },
    ])
  })

  test('buildThreadPlanFileTab opens plan files as thread-scoped tabs', () => {
    const tab = buildThreadPlanFileTab({
      threadId: 'thread-1',
      workspaceSlug: 'workspace-1',
      planFilePath: 'plans/plan-1.md',
    })

    expect(tab).toMatchObject({
      id: 'file:thread:workspace-1:thread-1:plans/plan-1.md',
      type: 'file',
      title: 'plan-1.md',
      filePath: 'plans/plan-1.md',
      fileSource: 'thread',
      threadId: 'thread-1',
      workspaceSlug: 'workspace-1',
    })
  })
})
