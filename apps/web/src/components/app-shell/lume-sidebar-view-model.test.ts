import { describe, expect, test } from 'bun:test'
import type { AgentThreadMeta, AgentWorkspace, AgentRuntimePhase } from '@lume/shared'
import { buildLumeSidebarViewModel } from './lume-sidebar-view-model'

function createWorkspace(overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
  return {
    id: 'workspace-1',
    name: '品牌工作区',
    slug: 'brand-workspace',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function createThread(overrides: Partial<AgentThreadMeta> = {}): AgentThreadMeta {
  const now = Date.now()

  return {
    id: 'thread-1',
    title: '欢迎会话',
    workspaceId: 'workspace-1',
    pinned: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('buildLumeSidebarViewModel', () => {
  test('returns the approved top action order', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [],
      currentWorkspaceId: 'workspace-1',
      activeTabId: null,
      streamingStates: {},
      expandedWorkspaceIds: ['workspace-1'],
    })

    expect(model.topActions.map((action) => action.id)).toEqual([
      'new-chat',
      'search',
      'lume',
      'skills',
      'automations',
    ])
    expect(model.topActions.find((action) => action.id === 'skills')?.label).toBe('技能 / 插件')
  })

  test('marks automation navigation active and enabled when the automation tab is open', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [],
      currentWorkspaceId: 'workspace-1',
      activeTabId: '__automation__',
      streamingStates: {},
      expandedWorkspaceIds: ['workspace-1'],
    })

    expect(model.topActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'automations',
          disabled: false,
          active: true,
        }),
      ]),
    )
    expect(model.collapsedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'automations',
          kind: 'top-action',
          disabled: false,
          active: true,
        }),
      ]),
    )
  })

  test('adds an active synthetic new conversation row for the current workspace welcome tab', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [createThread()],
      currentWorkspaceId: 'workspace-1',
      activeTabId: '__welcome__',
      streamingStates: {},
      expandedWorkspaceIds: ['workspace-1'],
    })

    const currentWorkspace = model.workspaces[0]

    expect(currentWorkspace.syntheticRow).toEqual({
      type: 'synthetic-thread',
      id: '__welcome__',
      workspaceId: 'workspace-1',
      label: '新对话',
      active: true,
    })
  })

  test('adds a new conversation row as the first row for every real workspace', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [
        createWorkspace(),
        createWorkspace({ id: 'workspace-2', name: '自动化', slug: 'automation' }),
      ],
      threads: [],
      currentWorkspaceId: 'workspace-1',
      activeTabId: '__welcome__',
      streamingStates: {},
      expandedWorkspaceIds: ['workspace-1', 'workspace-2'],
    })

    expect(model.workspaces[0].syntheticRow).toEqual({
      type: 'synthetic-thread',
      id: '__welcome__',
      workspaceId: 'workspace-1',
      label: '新对话',
      active: true,
    })
    expect(model.workspaces[1].syntheticRow).toEqual({
      type: 'synthetic-thread',
      id: '__welcome__',
      workspaceId: 'workspace-2',
      label: '新对话',
      active: false,
    })
  })

  test('produces thread groups from actual workspace threads', () => {
    const startOfToday = new Date().setHours(0, 0, 0, 0)
    const yesterday = startOfToday - 86_400_000 + 60_000

    const model = buildLumeSidebarViewModel({
      workspaces: [
        createWorkspace(),
        createWorkspace({ id: 'workspace-2', name: '自动化', slug: 'automation' }),
      ],
      threads: [
        createThread({ id: 'thread-today', title: '今天的线程', updatedAt: startOfToday + 120_000 }),
        createThread({
          id: 'thread-yesterday',
          title: '昨天的线程',
          workspaceId: 'workspace-2',
          updatedAt: yesterday,
        }),
      ],
      currentWorkspaceId: 'workspace-1',
      activeTabId: 'thread-yesterday',
      streamingStates: {
        'thread-yesterday': 'streaming' satisfies AgentRuntimePhase,
      },
      expandedWorkspaceIds: ['workspace-1', 'workspace-2'],
    })

    const automationWorkspace = model.workspaces.find((workspace) => workspace.id === 'workspace-2')
    expect(automationWorkspace?.threads).toHaveLength(1)
    expect(automationWorkspace?.threads[0]).toMatchObject({
      id: 'thread-yesterday',
      title: '昨天的线程',
      active: true,
      isStreaming: true,
    })
  })

  test('keeps labels in collapsed item data for tooltips and icon-only navigation', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [createThread()],
      currentWorkspaceId: 'workspace-1',
      activeTabId: 'thread-1',
      streamingStates: {},
      expandedWorkspaceIds: ['workspace-1'],
    })

    expect(model.collapsedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'new-chat',
          kind: 'top-action',
          label: '新建聊天',
        }),
        expect.objectContaining({
          id: 'workspace:workspace-1',
          kind: 'workspace',
          label: '品牌工作区',
        }),
        expect.objectContaining({
          id: 'settings',
          kind: 'footer-action',
          label: '设置',
        }),
      ]),
    )
  })

  test('keeps recycle bin available for the trash footer flow', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [],
      currentWorkspaceId: 'workspace-1',
      activeTabId: null,
      streamingStates: {},
      expandedWorkspaceIds: ['workspace-1'],
    })

    expect(model.footerActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'recycle-bin',
        }),
      ]),
    )
    expect(model.footerActions.find((action) => action.id === 'recycle-bin')).not.toHaveProperty('disabled', true)
    expect(model.collapsedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'recycle-bin',
          kind: 'footer-action',
        }),
      ]),
    )
    expect(model.collapsedItems.find((action) => action.id === 'recycle-bin')).not.toHaveProperty('disabled', true)
  })

  test('keeps unassigned threads discoverable in a dedicated bucket without remapping them between workspaces', () => {
    const workspaces = [
      createWorkspace(),
      createWorkspace({ id: 'workspace-2', name: '自动化', slug: 'automation' }),
    ]
    const threads = [
      createThread({
        id: 'legacy-thread',
        title: 'Legacy thread',
        workspaceId: undefined,
      }),
    ]

    const currentFirstWorkspace = buildLumeSidebarViewModel({
      workspaces,
      threads,
      currentWorkspaceId: 'workspace-1',
      activeTabId: null,
      streamingStates: {},
      expandedWorkspaceIds: ['workspace-1', 'workspace-2'],
    })
    const currentSecondWorkspace = buildLumeSidebarViewModel({
      workspaces,
      threads,
      currentWorkspaceId: 'workspace-2',
      activeTabId: null,
      streamingStates: {},
      expandedWorkspaceIds: ['workspace-1', 'workspace-2'],
    })

    const firstUnassigned = currentFirstWorkspace.workspaces.find((workspace) => workspace.id === '__unassigned__')
    const secondUnassigned = currentSecondWorkspace.workspaces.find((workspace) => workspace.id === '__unassigned__')

    expect(currentFirstWorkspace.workspaces.slice(0, 2).map((workspace) => workspace.count)).toEqual([0, 0])
    expect(currentSecondWorkspace.workspaces.slice(0, 2).map((workspace) => workspace.count)).toEqual([0, 0])
    expect(firstUnassigned).toMatchObject({
      id: '__unassigned__',
      name: '未分配',
      count: 1,
      isCurrent: false,
    })
    expect(secondUnassigned).toMatchObject({
      id: '__unassigned__',
      name: '未分配',
      count: 1,
      isCurrent: false,
    })
    expect(firstUnassigned?.threads).toEqual(secondUnassigned?.threads)
    expect(firstUnassigned?.threads).toEqual([
      {
        id: 'legacy-thread',
        title: 'Legacy thread',
        active: false,
        pinned: false,
        isStreaming: false,
        updatedAt: threads[0].updatedAt,
      },
    ])
    expect(currentFirstWorkspace.collapsedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'workspace:__unassigned__',
          workspaceId: '__unassigned__',
          label: '未分配',
        }),
      ]),
    )
  })
})
