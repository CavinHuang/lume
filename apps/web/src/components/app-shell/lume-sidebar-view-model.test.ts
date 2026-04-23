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
      'skills',
      'automations',
    ])
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
    const syntheticRow = currentWorkspace.rows.find((row) => row.type === 'synthetic-thread')

    expect(syntheticRow).toEqual({
      type: 'synthetic-thread',
      id: '__welcome__',
      label: '新对话',
      active: true,
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
    const groups = automationWorkspace?.rows.filter((row) => row.type === 'thread-group') ?? []

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      type: 'thread-group',
      label: '昨天',
    })
    expect(groups[0].items).toHaveLength(1)
    expect(groups[0].items[0]).toMatchObject({
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

  test('marks recycle bin disabled until a real footer flow exists', () => {
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
          disabled: true,
        }),
      ]),
    )
    expect(model.collapsedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'recycle-bin',
          kind: 'footer-action',
          disabled: true,
        }),
      ]),
    )
  })
})
