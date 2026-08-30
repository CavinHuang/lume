import { describe, expect, test, beforeEach } from 'bun:test'
import { createStore } from 'jotai'
import {
  rightPanelLayoutAtom,
  rightPanelLayoutsAtom,
  rightPanelFileWorkspacesAtom,
  rightPanelWorkspaceActionAtom,
} from '@/atoms/right-panel-atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { readRightPanelWorkspaceState, resetRightPanelWorkspaceStore } from '@/components/right-panel/right-panel-workspace-store'

beforeEach(() => {
  resetRightPanelWorkspaceStore()
})

describe('right-panel layout', () => {
  test('new threads start with the right panel closed', () => {
    const store = createStore()
    store.set(tabsAtom, [
      { id: 'old-tab', type: 'agent', title: 'Old', threadId: 'old-thread' },
      { id: 'new-tab', type: 'agent', title: 'New', threadId: 'new-thread' },
    ])
    store.set(rightPanelLayoutsAtom, {
      'old-thread': { open: true, mode: 'expanded', width: 720 },
    })
    store.set(activeTabIdAtom, 'new-tab')

    expect(store.get(rightPanelLayoutAtom)).toEqual({ open: false, mode: 'normal' })
  })

  test('restores layout independently for each thread', () => {
    const store = createStore()
    store.set(tabsAtom, [
      { id: 'first-tab', type: 'agent', title: 'First', threadId: 'first-thread' },
      { id: 'second-tab', type: 'agent', title: 'Second', threadId: 'second-thread' },
    ])
    store.set(rightPanelLayoutsAtom, {})
    store.set(activeTabIdAtom, 'first-tab')
    store.set(rightPanelLayoutAtom, { open: true, mode: 'expanded', width: 680 })

    store.set(activeTabIdAtom, 'second-tab')
    expect(store.get(rightPanelLayoutAtom)).toEqual({ open: false, mode: 'normal' })
    store.set(rightPanelLayoutAtom, (current) => ({ ...current, open: true, width: 440 }))

    store.set(activeTabIdAtom, 'first-tab')
    expect(store.get(rightPanelLayoutAtom)).toEqual({ open: true, mode: 'expanded', width: 680 })
    expect(store.get(rightPanelLayoutsAtom)['second-thread']).toEqual({ open: true, mode: 'normal', width: 440 })
  })
})

describe('right-panel unified tab actions', () => {
  test('activate-function opens the unified tab and points the runtime at it', () => {
    const store = createStore()

    store.set(rightPanelWorkspaceActionAtom, {
      type: 'activate-function',
      threadId: 'thread',
      function: 'browser',
    })

    const unified = readRightPanelWorkspaceState('thread')
    expect(unified.tabs.map((tab) => tab.type)).toEqual(['browser'])
    expect(unified.activeTabId).toBe('browser')
    expect(unified.collapsed).toBe(false)
    expect(store.get(rightPanelFileWorkspacesAtom).thread?.activeItem).toEqual({ kind: 'function', type: 'browser' })
  })

  test('opening a file does not recreate the independently closed Files function', () => {
    const store = createStore()

    store.set(rightPanelWorkspaceActionAtom, {
      type: 'open-file',
      threadId: 'thread',
      binding: { fileContextId: 'context' },
      ref: { source: 'session', scopeId: 'context', relativePath: 'result.png' },
    })

    // 统一 tab 集合保持空(files 未被复活);文件 tab 落在 runtime
    expect(readRightPanelWorkspaceState('thread').tabs).toEqual([])
    expect(store.get(rightPanelFileWorkspacesAtom).thread?.openTabs).toHaveLength(1)
  })

  test('closing the active unified tab falls back to the neighbor and syncs the runtime', () => {
    const store = createStore()
    store.set(rightPanelWorkspaceActionAtom, { type: 'activate-function', threadId: 'thread', function: 'files' })
    store.set(rightPanelWorkspaceActionAtom, { type: 'activate-function', threadId: 'thread', function: 'vault' })

    store.set(rightPanelWorkspaceActionAtom, { type: 'close-function', threadId: 'thread', function: 'vault' })

    const unified = readRightPanelWorkspaceState('thread')
    expect(unified.tabs.map((tab) => tab.type)).toEqual(['files'])
    expect(unified.activeTabId).toBe('files')
    expect(unified.collapsed).toBe(false)
    expect(store.get(rightPanelFileWorkspacesAtom).thread?.activeItem).toEqual({ kind: 'function', type: 'files' })
  })

  test('closing the last unified tab collapses and clears the runtime active item', () => {
    const store = createStore()
    store.set(rightPanelWorkspaceActionAtom, { type: 'activate-function', threadId: 'thread', function: 'git' })

    store.set(rightPanelWorkspaceActionAtom, { type: 'close-function', threadId: 'thread', function: 'git' })

    expect(readRightPanelWorkspaceState('thread')).toEqual({ tabs: [], activeTabId: null, collapsed: true })
    expect(store.get(rightPanelFileWorkspacesAtom).thread?.activeItem).toBeNull()
  })
})
