import { describe, expect, test } from 'bun:test'
import type { Tab } from '@/atoms/tab-atoms'
import * as LeftSidebarModule from './LeftSidebar'

const upsertWelcomeTab = (
  LeftSidebarModule as {
    upsertWelcomeTab?: (tabs: Tab[], workspaceId: string | null) => Tab[]
  }
).upsertWelcomeTab

describe('LeftSidebar welcome tab state', () => {
  test('retargets an existing welcome tab to the currently selected workspace before reopening it', () => {
    const tabs: Tab[] = [
      {
        id: '__welcome__',
        type: 'welcome',
        title: '新会话',
        workspaceId: 'workspace-1',
      },
      {
        id: 'thread-1',
        type: 'agent',
        title: '已有线程',
        threadId: 'thread-1',
      },
    ]

    expect(upsertWelcomeTab).toBeDefined()
    expect(upsertWelcomeTab?.(tabs, 'workspace-2')).toEqual([
      {
        id: '__welcome__',
        type: 'welcome',
        title: '新会话',
        workspaceId: 'workspace-2',
      },
      {
        id: 'thread-1',
        type: 'agent',
        title: '已有线程',
        threadId: 'thread-1',
      },
    ])
  })
})
