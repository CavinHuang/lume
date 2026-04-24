import { describe, expect, test } from 'bun:test'
import type { Tab } from '@/atoms/tab-atoms'
import * as LeftSidebarModule from './LeftSidebar'

const upsertWelcomeTab = (
  LeftSidebarModule as {
    upsertWelcomeTab?: (tabs: Tab[], workspaceId: string | null) => Tab[]
    retargetWelcomeTabIfActive?: (tabs: Tab[], activeTabId: string | null, workspaceId: string | null) => Tab[]
    applyWorkspaceSelection?: (input: {
      tabs: Tab[]
      activeTabId: string | null
      expandedWorkspaceIds: string[]
      currentWorkspaceId: string | null
      workspaceId: string
    }) => {
      tabs: Tab[]
      currentWorkspaceId: string | null
      expandedWorkspaceIds: string[]
    }
    applyWorkspaceToggle?: (input: {
      tabs: Tab[]
      activeTabId: string | null
      expandedWorkspaceIds: string[]
      currentWorkspaceId: string | null
      workspaceId: string
    }) => {
      tabs: Tab[]
      currentWorkspaceId: string | null
      expandedWorkspaceIds: string[]
    }
  }
).upsertWelcomeTab
const retargetWelcomeTabIfActive = (
  LeftSidebarModule as {
    upsertWelcomeTab?: (tabs: Tab[], workspaceId: string | null) => Tab[]
    retargetWelcomeTabIfActive?: (tabs: Tab[], activeTabId: string | null, workspaceId: string | null) => Tab[]
    applyWorkspaceSelection?: (input: {
      tabs: Tab[]
      activeTabId: string | null
      expandedWorkspaceIds: string[]
      currentWorkspaceId: string | null
      workspaceId: string
    }) => {
      tabs: Tab[]
      currentWorkspaceId: string | null
      expandedWorkspaceIds: string[]
    }
    applyWorkspaceToggle?: (input: {
      tabs: Tab[]
      activeTabId: string | null
      expandedWorkspaceIds: string[]
      currentWorkspaceId: string | null
      workspaceId: string
    }) => {
      tabs: Tab[]
      currentWorkspaceId: string | null
      expandedWorkspaceIds: string[]
    }
  }
).retargetWelcomeTabIfActive
const applyWorkspaceSelection = (
  LeftSidebarModule as {
    upsertWelcomeTab?: (tabs: Tab[], workspaceId: string | null) => Tab[]
    retargetWelcomeTabIfActive?: (tabs: Tab[], activeTabId: string | null, workspaceId: string | null) => Tab[]
    applyWorkspaceSelection?: (input: {
      tabs: Tab[]
      activeTabId: string | null
      expandedWorkspaceIds: string[]
      currentWorkspaceId: string | null
      workspaceId: string
    }) => {
      tabs: Tab[]
      currentWorkspaceId: string | null
      expandedWorkspaceIds: string[]
    }
    applyWorkspaceToggle?: (input: {
      tabs: Tab[]
      activeTabId: string | null
      expandedWorkspaceIds: string[]
      currentWorkspaceId: string | null
      workspaceId: string
    }) => {
      tabs: Tab[]
      currentWorkspaceId: string | null
      expandedWorkspaceIds: string[]
    }
  }
).applyWorkspaceSelection
const applyWorkspaceToggle = (
  LeftSidebarModule as {
    applyWorkspaceToggle?: (input: {
      tabs: Tab[]
      activeTabId: string | null
      expandedWorkspaceIds: string[]
      currentWorkspaceId: string | null
      workspaceId: string
    }) => {
      tabs: Tab[]
      currentWorkspaceId: string | null
      expandedWorkspaceIds: string[]
    }
  }
).applyWorkspaceToggle

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

  test('workspace selection keeps the active welcome tab and expanded ids in sync', () => {
    const tabs: Tab[] = [
      {
        id: '__welcome__',
        type: 'welcome',
        title: '新会话',
        workspaceId: 'workspace-1',
      },
    ]

    expect(applyWorkspaceSelection).toBeDefined()
    expect(
      applyWorkspaceSelection?.({
        tabs,
        activeTabId: '__welcome__',
        expandedWorkspaceIds: ['workspace-1'],
        currentWorkspaceId: 'workspace-1',
        workspaceId: 'workspace-2',
      }),
    ).toEqual({
      tabs: [
        {
          id: '__welcome__',
          type: 'welcome',
          title: '新会话',
          workspaceId: 'workspace-2',
        },
      ],
      currentWorkspaceId: 'workspace-2',
      expandedWorkspaceIds: ['workspace-1', 'workspace-2'],
    })
  })

  test('selecting the unassigned bucket only expands it without changing the real current workspace', () => {
    const tabs: Tab[] = [
      {
        id: '__welcome__',
        type: 'welcome',
        title: '新会话',
        workspaceId: 'workspace-1',
      },
    ]

    expect(
      applyWorkspaceSelection?.({
        tabs,
        activeTabId: '__welcome__',
        expandedWorkspaceIds: ['workspace-1'],
        currentWorkspaceId: 'workspace-1',
        workspaceId: '__unassigned__',
      }),
    ).toEqual({
      tabs,
      currentWorkspaceId: 'workspace-1',
      expandedWorkspaceIds: ['workspace-1', '__unassigned__'],
    })
  })

  test('workspace header toggle reopens the current workspace after all workspaces are collapsed', () => {
    const tabs: Tab[] = [
      {
        id: '__welcome__',
        type: 'welcome',
        title: '新会话',
        workspaceId: 'workspace-1',
      },
    ]

    expect(applyWorkspaceToggle).toBeDefined()
    expect(
      applyWorkspaceToggle?.({
        tabs,
        activeTabId: '__welcome__',
        expandedWorkspaceIds: [],
        currentWorkspaceId: 'workspace-1',
        workspaceId: 'workspace-1',
      }),
    ).toEqual({
      tabs,
      currentWorkspaceId: 'workspace-1',
      expandedWorkspaceIds: ['workspace-1'],
    })
  })

  test('workspace header toggle retargets the active welcome tab when opening another workspace', () => {
    const tabs: Tab[] = [
      {
        id: '__welcome__',
        type: 'welcome',
        title: '新会话',
        workspaceId: 'workspace-1',
      },
    ]

    expect(
      applyWorkspaceToggle?.({
        tabs,
        activeTabId: '__welcome__',
        expandedWorkspaceIds: [],
        currentWorkspaceId: 'workspace-1',
        workspaceId: 'workspace-2',
      }),
    ).toEqual({
      tabs: [
        {
          id: '__welcome__',
          type: 'welcome',
          title: '新会话',
          workspaceId: 'workspace-2',
        },
      ],
      currentWorkspaceId: 'workspace-2',
      expandedWorkspaceIds: ['workspace-2'],
    })
  })
})
