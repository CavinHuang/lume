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
const deriveRecentTrayThreads = (
  LeftSidebarModule as {
    deriveRecentTrayThreads?: typeof LeftSidebarModule.deriveRecentTrayThreads
  }
).deriveRecentTrayThreads
const confirmTrayThreadNavigation = LeftSidebarModule.confirmTrayThreadNavigation

describe('LeftSidebar tray conversations', () => {
  test('keeps the five latest active root conversations without pin reordering', () => {
    const thread = (id: string, updatedAt: number, extra = {}) => ({
      id,
      title: id,
      createdAt: 1,
      updatedAt,
      ...extra,
    })
    expect(deriveRecentTrayThreads?.([
      thread('old', 1),
      thread('child', 9, { parentThreadId: 'root' }),
      thread('archived', 10, { status: 'archived' }),
      thread('six', 2, { pinned: true }),
      thread('five', 3),
      thread('four', 4),
      thread('three', 5),
      thread('two', 6),
      thread('one', 7),
    ])).toEqual([
      { id: 'one', title: 'one', updatedAt: 7 },
      { id: 'two', title: 'two', updatedAt: 6 },
      { id: 'three', title: 'three', updatedAt: 5 },
      { id: 'four', title: 'four', updatedAt: 4 },
      { id: 'five', title: 'five', updatedAt: 3 },
    ])
  })

  test('authoritatively confirms a tray thread and immediately syncs the selected snapshot', async () => {
    const threads = [
      { id: 'target', title: '目标', createdAt: 1, updatedAt: 3 },
      { id: 'other', title: '其他', createdAt: 1, updatedAt: 2 },
    ]
    const syncCalls: unknown[][] = []
    const result = await confirmTrayThreadNavigation({
      threadId: 'target',
      generation: 7,
      activeThreadId: 'other',
      listThreads: async () => threads,
      syncTrayState: async (...args) => { syncCalls.push(args) },
    })

    expect(result.target?.id).toBe('target')
    expect(syncCalls).toEqual([[7, [
      { id: 'target', title: '目标', updatedAt: 3 },
      { id: 'other', title: '其他', updatedAt: 2 },
    ], 'target']])
  })

  test('removes a locally stale target even when the authoritative tray signature is unchanged', async () => {
    const authoritative = [{ id: 'other', title: '其他', createdAt: 1, updatedAt: 2 }]
    const syncCalls: unknown[][] = []
    const result = await confirmTrayThreadNavigation({
      threadId: 'deleted-locally-still-present',
      generation: 8,
      activeThreadId: 'other',
      listThreads: async () => authoritative,
      syncTrayState: async (...args) => { syncCalls.push(args) },
    })

    expect(result.target).toBeNull()
    expect(syncCalls).toEqual([[8, [{ id: 'other', title: '其他', updatedAt: 2 }], 'other']])
  })

  test('fails closed without changing the tray snapshot when authority confirmation fails or times out', async () => {
    let syncCount = 0
    const syncTrayState = async () => { syncCount += 1 }
    await expect(confirmTrayThreadNavigation({
      threadId: 'target',
      generation: 9,
      activeThreadId: null,
      listThreads: async () => { throw new Error('offline') },
      syncTrayState,
    })).rejects.toThrow('offline')
    await expect(confirmTrayThreadNavigation({
      threadId: 'target',
      generation: 9,
      activeThreadId: null,
      listThreads: () => new Promise(() => {}),
      syncTrayState,
      timeoutMs: 0,
    })).rejects.toThrow('timed out')
    expect(syncCount).toBe(0)
  })
})

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
