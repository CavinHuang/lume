import { describe, expect, test } from 'bun:test'
import type { Tab } from '@/atoms/tab-atoms'
import * as LeftSidebarModule from './LeftSidebar'

const upsertWelcomeTab = (
  LeftSidebarModule as {
    upsertWelcomeTab?: (tabs: Tab[], workspaceId: string | null) => Tab[]
    retargetWelcomeTabIfActive?: (tabs: Tab[], activeTabId: string | null, workspaceId: string | null) => Tab[]
  }
).upsertWelcomeTab
const retargetWelcomeTabIfActive = (
  LeftSidebarModule as {
    upsertWelcomeTab?: (tabs: Tab[], workspaceId: string | null) => Tab[]
    retargetWelcomeTabIfActive?: (tabs: Tab[], activeTabId: string | null, workspaceId: string | null) => Tab[]
  }
).retargetWelcomeTabIfActive

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

  test('retargets an already active welcome tab when the sidebar workspace changes', () => {
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

    expect(retargetWelcomeTabIfActive).toBeDefined()
    expect(retargetWelcomeTabIfActive?.(tabs, '__welcome__', 'workspace-2')).toEqual([
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
    expect(retargetWelcomeTabIfActive?.(tabs, 'thread-1', 'workspace-2')).toEqual(tabs)
  })
})
