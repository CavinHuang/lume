import { describe, expect, test } from 'bun:test'
import {
  RIGHT_PANEL_CLOSED_RING_LIMIT,
  activateRightPanelTab,
  closeAllRightPanelTabs,
  closeOtherRightPanelTabs,
  closeRightPanelTab,
  createEmptyRightPanelWorkspace,
  createRightPanelTab,
  firstOpenRightPanelTab,
  getAvailableRightPanelFunctions,
  getOpenRightPanelFunctions,
  getRightPanelReviewLaunchTarget,
  openRightPanelTab,
  pushRightPanelClosedRing,
  recomputeRightPanelCollapse,
  reorderRightPanelTabs,
  resolveRightPanelWorkspaceKey,
  nextTerminalInstanceTitle,
  openRightPanelInstanceTab,
  sanitizeRightPanelWorkspaceState,
} from './right-panel-state'

const tab = (type: Parameters<typeof createRightPanelTab>[0]) => createRightPanelTab(type)

describe('right-panel-state tab model', () => {
  test('open upserts singleton tabs, activates them and expands the pane', () => {
    let workspace = openRightPanelTab(createEmptyRightPanelWorkspace(), 'files')
    workspace = openRightPanelTab(workspace, 'files')
    workspace = openRightPanelTab(workspace, 'vault')

    // 单例幂等:files 不重复;打开顺序即数组序(用户可重排)
    expect(workspace.tabs).toEqual([tab('files'), tab('vault')])
    expect(workspace.activeTabId).toBe('vault')
    expect(workspace.collapsed).toBe(false)
    // browser/terminal 尚未打开,仍在可用清单里(菜单序,ZCode terminal 恒有且先于 browser)
    expect(getAvailableRightPanelFunctions(workspace.tabs)).toEqual(['terminal', 'browser', 'git'])
    expect(getOpenRightPanelFunctions(workspace.tabs)).toEqual(['files', 'vault'])
  })

  test('re-opening an existing tab keeps its position and only activates it', () => {
    let workspace = openRightPanelTab(createEmptyRightPanelWorkspace(), 'files')
    workspace = openRightPanelTab(workspace, 'vault')
    workspace = openRightPanelTab(workspace, 'files')

    expect(workspace.tabs.map((item) => item.type)).toEqual(['files', 'vault'])
    expect(workspace.activeTabId).toBe('files')
  })

  test('activate expands a collapsed pane and ignores unknown ids', () => {
    let workspace = { ...openRightPanelTab(createEmptyRightPanelWorkspace(), 'browser'), collapsed: true }
    workspace = activateRightPanelTab(workspace, 'browser')
    expect(workspace.collapsed).toBe(false)
    expect(workspace.activeTabId).toBe('browser')

    expect(activateRightPanelTab(workspace, 'nope')).toBe(workspace)
  })

  test('close activates the neighbor at the same index (ZCode wd)', () => {
    let workspace = createEmptyRightPanelWorkspace()
    for (const type of ['files', 'vault', 'browser'] as const) workspace = openRightPanelTab(workspace, type)
    workspace = activateRightPanelTab(workspace, 'vault')

    workspace = closeRightPanelTab(workspace, 'vault')
    expect(workspace.tabs.map((item) => item.type)).toEqual(['files', 'browser'])
    // 原索引处邻居 = browser
    expect(workspace.activeTabId).toBe('browser')
  })

  test('closing a non-active tab keeps the active tab; closing the active tail falls back left', () => {
    let workspace = createEmptyRightPanelWorkspace()
    for (const type of ['files', 'vault', 'browser'] as const) workspace = openRightPanelTab(workspace, type)
    workspace = activateRightPanelTab(workspace, 'browser')

    workspace = closeRightPanelTab(workspace, 'files')
    expect(workspace.tabs.map((item) => item.type)).toEqual(['vault', 'browser'])
    expect(workspace.activeTabId).toBe('browser')

    workspace = closeRightPanelTab(workspace, 'browser')
    expect(workspace.tabs.map((item) => item.type)).toEqual(['vault'])
    expect(workspace.activeTabId).toBe('vault')
  })

  test('closing the last tab empties the workspace and auto-collapses (ZCode ode)', () => {
    let workspace = openRightPanelTab(createEmptyRightPanelWorkspace(), 'git')
    workspace = closeRightPanelTab(workspace, 'git')
    expect(workspace).toEqual({ tabs: [], activeTabId: null, collapsed: true })
    expect(recomputeRightPanelCollapse(workspace)).toBe(workspace)
  })

  test('close others keeps the target activated (ZCode Ede) and returns the closed tabs', () => {
    let workspace = createEmptyRightPanelWorkspace()
    for (const type of ['files', 'vault', 'browser'] as const) workspace = openRightPanelTab(workspace, type)
    workspace = activateRightPanelTab(workspace, 'files')

    const [next, closed] = closeOtherRightPanelTabs(workspace, 'files')
    expect(next.tabs).toEqual([tab('files')])
    expect(next.activeTabId).toBe('files')
    expect(closed.map((item) => item.type)).toEqual(['vault', 'browser'])

    // 目标不存在时保持原状
    const [unchanged, none] = closeOtherRightPanelTabs(workspace, 'nope')
    expect(unchanged).toBe(workspace)
    expect(none).toEqual([])
  })

  test('close all empties and collapses (ZCode Dde)', () => {
    let workspace = createEmptyRightPanelWorkspace()
    for (const type of ['files', 'vault'] as const) workspace = openRightPanelTab(workspace, type)
    const [next, closed] = closeAllRightPanelTabs(workspace)
    expect(next).toEqual({ tabs: [], activeTabId: null, collapsed: true })
    expect(closed.map((item) => item.type)).toEqual(['files', 'vault'])
  })

  test('reorder applies full id permutations without touching the active tab (ZCode Ade)', () => {
    let workspace = createEmptyRightPanelWorkspace()
    for (const type of ['files', 'vault', 'git'] as const) workspace = openRightPanelTab(workspace, type)
    workspace = activateRightPanelTab(workspace, 'vault')

    const reordered = reorderRightPanelTabs(workspace, ['git', 'vault', 'files'])
    expect(reordered.tabs.map((item) => item.type)).toEqual(['git', 'vault', 'files'])
    expect(reordered.activeTabId).toBe('vault')

    // 非全量/含未知 id:保持原序
    expect(reorderRightPanelTabs(workspace, ['files', 'vault'])).toBe(workspace)
    expect(reorderRightPanelTabs(workspace, ['files', 'vault', 'nope'])).toBe(workspace)
  })

  test('sanitize drops unknown types, dedupes ids and repairs a stale activeTabId', () => {
    expect(sanitizeRightPanelWorkspaceState({
      tabs: [
        { id: 'files', type: 'files', selectedPath: 'secret.txt' },
        { id: 'files', type: 'files' },
        { type: 'git' },
        { type: 'review' },
      ],
      activeTabId: 'gone',
      collapsed: false,
    })).toEqual({
      tabs: [tab('files'), tab('git')],
      activeTabId: 'git',
      collapsed: false,
    })

    expect(sanitizeRightPanelWorkspaceState(null)).toEqual({ tabs: [], activeTabId: null, collapsed: false })
    expect(sanitizeRightPanelWorkspaceState({ tabs: [], collapsed: true })).toEqual({ tabs: [], activeTabId: null, collapsed: true })
  })

  test('terminal instances are non-singleton with deduped Zde titles', () => {
    let state = createEmptyRightPanelWorkspace()
    state = openRightPanelTab(state, 'terminal')
    state = openRightPanelInstanceTab(state, 'terminal-a', 'terminal', 'repo')
    state = openRightPanelInstanceTab(state, 'terminal-b', 'terminal', 'repo 2')
    expect(state.tabs.map((tab) => ({ id: tab.id, title: tab.title }))).toEqual([
      { id: 'terminal', title: undefined },
      { id: 'terminal-a', title: 'repo' },
      { id: 'terminal-b', title: 'repo 2' },
    ])
    expect(state.activeTabId).toBe('terminal-b')

    // 同 id 幂等激活(重放竞态);Zde 查重跳过既有标题
    state = openRightPanelInstanceTab(state, 'terminal-b', 'terminal', 'repo 2')
    expect(state.activeTabId).toBe('terminal-a')
    expect(nextTerminalInstanceTitle(state, 'repo')).toBe('repo 3')
    expect(nextTerminalInstanceTitle(state, 'fresh')).toBe('fresh')

    // 实例参与关闭语义(closeRightPanelTab 原样复用)
    const closed = closeRightPanelTab(state, 'terminal-a')
    expect(closed.tabs.map((tab) => tab.id)).toEqual(['terminal', 'terminal-b'])
    expect(closed.activeTabId).toBe('terminal-b')
  })

  test('sanitize preserves terminal instance titles and drops malformed ones', () => {
    const sanitized = sanitizeRightPanelWorkspaceState({
      tabs: [
        { id: 'terminal', type: 'terminal' },
        { id: 'terminal-a', type: 'terminal', title: '  repo  ' },
        { id: 'terminal-b', type: 'terminal', title: 42 },
      ],
      activeTabId: 'terminal-a',
      collapsed: false,
    })
    expect(sanitized.tabs).toEqual([
      { id: 'terminal', type: 'terminal' },
      { id: 'terminal-a', type: 'terminal', title: 'repo' },
      { id: 'terminal-b', type: 'terminal' },
    ])
  })

  test('workspace key resolution matches the browser panel bucket identity', () => {
    expect(resolveRightPanelWorkspaceKey({ workspaceSlug: 'slug', workspaceId: 'ws', threadId: 't' })).toBe('slug')
    expect(resolveRightPanelWorkspaceKey({ workspaceId: 'ws', threadId: 't' })).toBe('ws')
    expect(resolveRightPanelWorkspaceKey({ threadId: 't' })).toBe('t')
  })

  test('first open function follows the user tab order', () => {
    expect(firstOpenRightPanelTab([tab('vault'), tab('files')])).toBe('vault')
    expect(firstOpenRightPanelTab([])).toBeNull()
  })
})

describe('right-panel closed ring', () => {
  test('pushes new entries at the head, dedupes by id and caps at 8 (ZCode Xde)', () => {
    let ring = pushRightPanelClosedRing([], [tab('files')], 1)
    ring = pushRightPanelClosedRing(ring, [tab('vault')], 2)
    ring = pushRightPanelClosedRing(ring, [tab('files')], 3)

    expect(ring.map((entry) => entry.tab.type)).toEqual(['files', 'vault'])
    expect(ring[0]!.closedAt).toBe(3)

    for (let index = 0; index < 10; index += 1) {
      ring = pushRightPanelClosedRing(ring, [{ id: `files-${index}`, type: 'files' }], 100 + index)
    }
    expect(ring).toHaveLength(RIGHT_PANEL_CLOSED_RING_LIMIT)
  })

  test('excludes chat (ZCode selection-side-chat semantics)', () => {
    expect(pushRightPanelClosedRing([], [tab('chat')])).toEqual([])
  })
})

test('review launcher opens the current changed turn or falls back to the previous turn', () => {
  const previousReport = {
    runId: 'run-1',
    status: 'unverified' as const,
    workspaceChanged: true,
    changedFiles: ['src/previous.ts'],
    fileChanges: [{ path: 'src/previous.ts' }],
    externalChangedFiles: [],
    pendingBackground: false,
  }
  const currentReport = {
    ...previousReport,
    runId: 'run-2',
    changedFiles: ['src/current.ts'],
    fileChanges: [{ path: 'src/current.ts' }],
  }
  const baseEvents = [
    {
      id: 'started-1',
      type: 'run.started' as const,
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-07-30T00:00:00.000Z',
    },
    {
      id: 'report-1',
      type: 'coding.report.updated' as const,
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-07-30T00:01:00.000Z',
      codingReport: previousReport,
    },
    {
      id: 'started-2',
      type: 'run.started' as const,
      threadId: 'thread-1',
      runId: 'run-2',
      createdAt: '2026-07-30T00:02:00.000Z',
    },
  ]

  expect(getRightPanelReviewLaunchTarget(baseEvents)).toMatchObject({
    recency: 'previous',
    report: { runId: 'run-1' },
    changes: [{ path: 'src/previous.ts' }],
  })
  expect(getRightPanelReviewLaunchTarget([
    ...baseEvents,
    {
      id: 'report-2',
      type: 'coding.report.updated' as const,
      threadId: 'thread-1',
      runId: 'run-2',
      createdAt: '2026-07-30T00:03:00.000Z',
      codingReport: currentReport,
    },
  ])).toMatchObject({
    recency: 'current',
    report: { runId: 'run-2' },
    changes: [{ path: 'src/current.ts' }],
  })
})
