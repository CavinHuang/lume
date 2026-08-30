import { describe, expect, test, beforeEach } from 'bun:test'
import {
  RIGHT_PANEL_WORKSPACE_STORE_LIMIT,
  getRightPanelClosedRing,
  getRightPanelStoreVersion,
  handleActivateTab,
  handleCloseAllTabs,
  handleCloseOtherTabs,
  handleCloseTab,
  handleOpenTab,
  handleReopenClosedTab,
  handleReorderTabs,
  handleToggleCollapse,
  readRightPanelWorkspaceState,
  resetRightPanelWorkspaceStore,
  subscribeRightPanelWorkspaces,
} from './right-panel-workspace-store'

beforeEach(() => {
  resetRightPanelWorkspaceStore()
})

describe('right-panel workspace store', () => {
  test('keeps buckets per workspace key and defaults to the empty snapshot', () => {
    handleOpenTab('ws-a', 'files')
    handleOpenTab('ws-b', 'browser')

    expect(readRightPanelWorkspaceState('ws-a').tabs.map((tab) => tab.type)).toEqual(['files'])
    expect(readRightPanelWorkspaceState('ws-b').tabs.map((tab) => tab.type)).toEqual(['browser'])
    expect(readRightPanelWorkspaceState('ws-c')).toEqual({ tabs: [], activeTabId: null, collapsed: false })
  })

  test('write ops activate, close ops push the closed ring and auto-collapse when empty', () => {
    handleOpenTab('ws', 'files')
    handleOpenTab('ws', 'git')
    handleActivateTab('ws', 'files')
    expect(readRightPanelWorkspaceState('ws').activeTabId).toBe('files')

    handleCloseTab('ws', 'git')
    expect(getRightPanelClosedRing().map((entry) => entry.tab.type)).toEqual(['git'])
    // 关非活动 tab:不动选中、不折叠
    expect(readRightPanelWorkspaceState('ws').activeTabId).toBe('files')
    expect(readRightPanelWorkspaceState('ws').collapsed).toBe(false)

    handleCloseTab('ws', 'files')
    expect(getRightPanelClosedRing().map((entry) => entry.tab.type)).toEqual(['files', 'git'])
    expect(readRightPanelWorkspaceState('ws').collapsed).toBe(true)
  })

  test('close others / close all / reorder follow the reducer semantics', () => {
    for (const type of ['files', 'vault', 'git'] as const) handleOpenTab('ws', type)
    handleActivateTab('ws', 'vault')

    handleReorderTabs('ws', ['git', 'vault', 'files'])
    expect(readRightPanelWorkspaceState('ws').tabs.map((tab) => tab.type)).toEqual(['git', 'vault', 'files'])
    expect(readRightPanelWorkspaceState('ws').activeTabId).toBe('vault')

    handleCloseOtherTabs('ws', 'vault')
    expect(readRightPanelWorkspaceState('ws').tabs.map((tab) => tab.type)).toEqual(['vault'])
    expect(readRightPanelWorkspaceState('ws').activeTabId).toBe('vault')
    // 关他入环顺序 = tab 排列序(重排在先:git, vault, files)
    expect(getRightPanelClosedRing().map((entry) => entry.tab.type)).toEqual(['git', 'files'])

    handleOpenTab('ws', 'browser')
    handleCloseAllTabs('ws')
    expect(readRightPanelWorkspaceState('ws')).toEqual({ tabs: [], activeTabId: null, collapsed: true })
    expect(getRightPanelClosedRing().map((entry) => entry.tab.type)).toEqual(['vault', 'browser', 'git', 'files'])
  })

  test('reopen removes the entry from the ring and upserts it activated', () => {
    handleOpenTab('ws', 'files')
    handleOpenTab('ws', 'vault')
    handleCloseTab('ws', 'files')

    const entryId = getRightPanelClosedRing()[0]!.tab.id
    handleReopenClosedTab('ws', entryId)

    expect(getRightPanelClosedRing()).toHaveLength(0)
    const state = readRightPanelWorkspaceState('ws')
    expect(state.tabs.map((tab) => tab.type)).toEqual(['vault', 'files'])
    expect(state.activeTabId).toBe('files')
    expect(state.collapsed).toBe(false)
  })

  test('toggle collapse flips the collapsed flag', () => {
    handleOpenTab('ws', 'files')
    handleToggleCollapse('ws')
    expect(readRightPanelWorkspaceState('ws').collapsed).toBe(true)
    handleToggleCollapse('ws')
    expect(readRightPanelWorkspaceState('ws').collapsed).toBe(false)
  })

  test('evicts the least recently written workspace beyond the 50-key cap (ZCode Dd)', () => {
    for (let index = 0; index < RIGHT_PANEL_WORKSPACE_STORE_LIMIT; index += 1) {
      handleOpenTab(`ws-${index}`, 'files')
    }
    // 触碰最早 key 使其刷新插入序
    handleToggleCollapse('ws-0')
    handleOpenTab('ws-new', 'files')

    expect(readRightPanelWorkspaceState('ws-new').tabs).toHaveLength(1)
    expect(readRightPanelWorkspaceState('ws-0').tabs).toHaveLength(1)
    // 未被触碰的最早 key(ws-1)被淘汰
    expect(readRightPanelWorkspaceState('ws-1')).toEqual({ tabs: [], activeTabId: null, collapsed: false })
  })

  test('notifies subscribers only on actual writes and keeps snapshot references stable', () => {
    let notifications = 0
    const unsubscribe = subscribeRightPanelWorkspaces(() => { notifications += 1 })

    handleOpenTab('ws', 'files')
    const snapshot = readRightPanelWorkspaceState('ws')
    const versionAfterOpen = getRightPanelStoreVersion()
    handleReorderTabs('ws', ['files'])
    // no-op reorder 不写不通知
    expect(notifications).toBe(1)
    expect(getRightPanelStoreVersion()).toBe(versionAfterOpen)
    expect(readRightPanelWorkspaceState('ws')).toBe(snapshot)

    handleOpenTab('ws', 'vault')
    expect(notifications).toBe(2)
    expect(getRightPanelStoreVersion()).toBe(versionAfterOpen + 1)
    expect(readRightPanelWorkspaceState('ws')).not.toBe(snapshot)

    unsubscribe()
  })
})
