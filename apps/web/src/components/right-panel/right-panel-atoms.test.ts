import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  rightPanelLayoutAtom,
  rightPanelLayoutsAtom,
  rightPanelFileWorkspacesAtom,
  rightPanelWorkspaceActionAtom,
  rightPanelWorkspacesAtom,
} from '@/atoms/right-panel-atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'

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

describe('right-panel file actions', () => {
  test('opening a file does not recreate the independently closed Files function', () => {
    const store = createStore()
    store.set(rightPanelWorkspacesAtom, { thread: { tabs: {} } })

    store.set(rightPanelWorkspaceActionAtom, {
      type: 'open-file',
      threadId: 'thread',
      binding: { fileContextId: 'context' },
      ref: { source: 'session', scopeId: 'context', relativePath: 'result.png' },
    })

    expect(store.get(rightPanelWorkspacesAtom).thread).toEqual({ tabs: {} })
    expect(store.get(rightPanelFileWorkspacesAtom).thread?.openTabs).toHaveLength(1)
  })
})
