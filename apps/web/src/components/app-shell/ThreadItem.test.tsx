import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ThreadItem } from './ThreadItem'
import { agentStreamingStatesAtom, agentSubagentRunsAtom } from '@/atoms'
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

function makeDelegateThread(): LumeSidebarThreadItem {
  return {
    id: 'p1',
    title: '父',
    active: false,
    pinned: false,
    updatedAt: 1,
    depth: 0,
    isDelegate: false,
    children: [
      {
        id: 'c1',
        title: '子',
        active: false,
        pinned: false,
        updatedAt: 1,
        parentThreadId: 'p1',
        depth: 1,
        isDelegate: true,
      } as LumeSidebarThreadItem,
    ],
  } as LumeSidebarThreadItem
}

describe('ThreadItem delegate tree', () => {
  test('父会话含子会话时显示完成计数与折叠箭头', () => {
    const store = createStore()
    store.set(agentSubagentRunsAtom, {
      p1: [
        {
          runId: 'r1',
          parentThreadId: 'p1',
          childThreadId: 'c1',
          status: 'completed',
          task: '',
          cleanup: 'keep',
          rootThreadId: 'p1',
          depth: 1,
        } as never,
      ],
    })
    const markup = renderToStaticMarkup(
      <Provider store={store}>
        <ThreadItem
          thread={makeDelegateThread()}
          onSelect={() => {}}
          onTogglePin={() => {}}
          onArchive={() => {}}
          onRename={() => {}}
        />
      </Provider>,
    )
    expect(markup).toContain('1/1')
  })

  test('子会话项有缩进竖线', () => {
    const markup = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ThreadItem
          thread={
            {
              id: 'c1',
              title: '子',
              active: false,
              pinned: false,
              updatedAt: 1,
              parentThreadId: 'p1',
              depth: 1,
              isDelegate: true,
            } as LumeSidebarThreadItem
          }
          onSelect={() => {}}
          onTogglePin={() => {}}
          onArchive={() => {}}
          onRename={() => {}}
        />
      </Provider>,
    )
    expect(markup).toContain('border-l')
  })
})
