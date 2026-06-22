import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ThreadItem } from './ThreadItem'
import { agentStreamingStatesAtom } from '@/atoms'
import type { LumeSidebarThreadItem } from './lume-sidebar-view-model'

function makeThread(): LumeSidebarThreadItem {
  return {
    id: 't1',
    title: '线程一',
    active: false,
    pinned: false,
    updatedAt: 0,
  } as unknown as LumeSidebarThreadItem
}

function renderMarkup(streaming: boolean): string {
  const store = createStore()
  store.set(agentStreamingStatesAtom, { t1: streaming ? 'streaming' : 'idle' })
  return renderToStaticMarkup(
    <Provider store={store}>
      <ThreadItem
        thread={makeThread()}
        onSelect={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
        onRename={() => {}}
      />
    </Provider>,
  )
}

describe('ThreadItem streaming indicator', () => {
  test('shows pulse dot when the thread is streaming', () => {
    expect(renderMarkup(true)).toContain('animate-pulse')
  })

  test('hides indicator when the thread is idle and not active', () => {
    expect(renderMarkup(false)).not.toContain('animate-pulse')
  })
})
