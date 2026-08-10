import { describe, expect, test } from 'bun:test'
import type { AgentThreadMeta, AgentWorkspace } from '@lume/shared'
import { buildLumeSidebarViewModel, UNASSIGNED_THREADS_WORKSPACE_ID } from './lume-sidebar-view-model'

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
  test('null project selection keeps ordinary sessions selected instead of selecting the first project', () => {
    const workspace = createWorkspace()
    const model = buildLumeSidebarViewModel({
      workspaces: [workspace],
      threads: [{
        id: 'ordinary-thread',
        title: '普通对话',
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
      }],
      currentWorkspaceId: null,
      activeTabId: null,
      expandedWorkspaceIds: [UNASSIGNED_THREADS_WORKSPACE_ID],
      pinnedWorkspaceIds: [],
    })

    expect(model.workspaces.find((item) => item.id === workspace.id)?.isCurrent).toBeFalse()
    expect(model.workspaces.find((item) => item.id === UNASSIGNED_THREADS_WORKSPACE_ID)).toMatchObject({
      name: '普通会话',
      isCurrent: true,
    })
  })
  test('returns the approved top action order', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [],
      currentWorkspaceId: 'workspace-1',
      activeTabId: null,
      expandedWorkspaceIds: ['workspace-1'],
    })

    expect(model.topActions.map((action) => action.id)).toEqual([
      'new-chat',
      'lume',
      'skills',
      'connectors',
      'automations',
      'todos',
      'proactive',
    ])
    expect(model.topActions.find((action) => action.id === 'skills')?.label).toBe('技能 / 插件')
    expect(model.topActions.find((action) => action.id === 'proactive')?.label).toBe('记忆与洞察')
  })

  test('marks automation navigation active and enabled when the automation tab is open', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [],
      currentWorkspaceId: 'workspace-1',
      activeTabId: '__automation__',
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
      expandedWorkspaceIds: ['workspace-1', 'workspace-2'],
    })

    const automationWorkspace = model.workspaces.find((workspace) => workspace.id === 'workspace-2')
    expect(automationWorkspace?.threads).toHaveLength(1)
    expect(automationWorkspace?.threads[0]).toMatchObject({
      id: 'thread-yesterday',
      title: '昨天的线程',
      active: true,
    })
  })

  test('keeps labels in collapsed item data for tooltips and icon-only navigation', () => {
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [createThread()],
      currentWorkspaceId: 'workspace-1',
      activeTabId: 'thread-1',
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
      expandedWorkspaceIds: ['workspace-1', 'workspace-2'],
    })
    const currentSecondWorkspace = buildLumeSidebarViewModel({
      workspaces,
      threads,
      currentWorkspaceId: 'workspace-2',
      activeTabId: null,
      expandedWorkspaceIds: ['workspace-1', 'workspace-2'],
    })

    const firstUnassigned = currentFirstWorkspace.workspaces.find((workspace) => workspace.id === '__unassigned__')
    const secondUnassigned = currentSecondWorkspace.workspaces.find((workspace) => workspace.id === '__unassigned__')

    expect(currentFirstWorkspace.workspaces.slice(0, 2).map((workspace) => workspace.count)).toEqual([0, 0])
    expect(currentSecondWorkspace.workspaces.slice(0, 2).map((workspace) => workspace.count)).toEqual([0, 0])
    expect(firstUnassigned).toMatchObject({
      id: '__unassigned__',
      name: '普通会话',
      count: 1,
      isCurrent: false,
    })
    expect(secondUnassigned).toMatchObject({
      id: '__unassigned__',
      name: '普通会话',
      count: 1,
      isCurrent: false,
    })
    expect(firstUnassigned?.threads).toEqual(secondUnassigned?.threads)
    expect(firstUnassigned?.threads).toEqual([
      expect.objectContaining({
        id: 'legacy-thread',
        title: 'Legacy thread',
        active: false,
        pinned: false,
        updatedAt: threads[0].updatedAt,
        depth: 0,
        isDelegate: false,
      }),
    ])
    expect(currentFirstWorkspace.collapsedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'workspace:__unassigned__',
          workspaceId: '__unassigned__',
          label: '普通会话',
        }),
      ]),
    )
  })
})

describe('buildLumeSidebarViewModel delegate tree', () => {
  test('子会话挂在父会话 children 下，根线程不含 parentThreadId', () => {
    const ws = createWorkspace({ id: 'ws-1', name: 'WS' })
    const parent = createThread({ id: 'p1', workspaceId: 'ws-1', title: '父', updatedAt: 100 })
    const child = createThread({ id: 'c1', workspaceId: 'ws-1', title: '子', parentThreadId: 'p1', updatedAt: 90 })
    const model = buildLumeSidebarViewModel({
      workspaces: [ws],
      threads: [parent, child],
      currentWorkspaceId: 'ws-1',
      activeTabId: null,
      expandedWorkspaceIds: ['ws-1'],
    })
    const wsItem = model.workspaces.find((w) => w.id === 'ws-1')!
    const parentItem = wsItem.threads.find((t) => t.id === 'p1')!

    expect(parentItem.parentThreadId).toBeUndefined()
    expect(parentItem.depth).toBe(0)
    expect(parentItem.isDelegate).toBe(false)
    expect(parentItem.children?.map((c) => c.id)).toEqual(['c1'])
    expect(parentItem.children?.[0].depth).toBe(1)
    expect(parentItem.children?.[0].isDelegate).toBe(true)
    expect(parentItem.children?.[0].parentThreadId).toBe('p1')
  })

  test('孤儿子会话（父不在列表）作为根显示，标记为非 delegate 根', () => {
    const ws = createWorkspace({ id: 'ws-1', name: 'WS' })
    const orphan = createThread({ id: 'o1', workspaceId: 'ws-1', parentThreadId: 'missing', updatedAt: 1 })
    const model = buildLumeSidebarViewModel({
      workspaces: [ws],
      threads: [orphan],
      currentWorkspaceId: 'ws-1',
      activeTabId: null,
      expandedWorkspaceIds: ['ws-1'],
    })
    const wsItem = model.workspaces.find((w) => w.id === 'ws-1')!
    const orphanItem = wsItem.threads.find((t) => t.id === 'o1')!

    expect(orphanItem).toBeDefined()
    expect(orphanItem.depth).toBe(0)
    // 父不在列表 → 当根；保留 parentThreadId 元数据但 isDelegate 按根处理为 false
    expect(orphanItem.isDelegate).toBe(false)
    expect(orphanItem.children).toBeUndefined()
  })

  test('嵌套孙会话 depth 递归递增', () => {
    const ws = createWorkspace({ id: 'ws-1', name: 'WS' })
    const root = createThread({ id: 'r1', workspaceId: 'ws-1', updatedAt: 300 })
    const mid = createThread({ id: 'm1', workspaceId: 'ws-1', parentThreadId: 'r1', updatedAt: 200 })
    const leaf = createThread({ id: 'l1', workspaceId: 'ws-1', parentThreadId: 'm1', updatedAt: 100 })
    const model = buildLumeSidebarViewModel({
      workspaces: [ws],
      threads: [root, mid, leaf],
      currentWorkspaceId: 'ws-1',
      activeTabId: 'l1',
      expandedWorkspaceIds: ['ws-1'],
    })
    const wsItem = model.workspaces.find((w) => w.id === 'ws-1')!
    const rootItem = wsItem.threads.find((t) => t.id === 'r1')!

    expect(rootItem.depth).toBe(0)
    expect(rootItem.children?.[0].id).toBe('m1')
    expect(rootItem.children?.[0].depth).toBe(1)
    expect(rootItem.children?.[0].children?.[0].id).toBe('l1')
    expect(rootItem.children?.[0].children?.[0].depth).toBe(2)
    expect(rootItem.children?.[0].children?.[0].active).toBe(true)
  })
})
