import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  rightPanelFileWorkspacesAtom,
  rightPanelWorkspaceActionAtom,
  rightPanelWorkspacesAtom,
} from '@/atoms/right-panel-atoms'

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
