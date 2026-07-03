import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ThreadMoreActions } from './ThreadMoreActions'
import { agentThreadsAtom } from '@/atoms'

describe('ThreadMoreActions', () => {
  test('渲染「更多操作」触发按钮', () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: '我的会话', pinned: false }])
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <ThreadMoreActions threadId="t1" />
      </Provider>,
    )
    expect(html).toContain('更多操作')
  })

  test('readOnly 模式渲染不抛错', () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: 'T', pinned: false }])
    expect(() =>
      renderToStaticMarkup(
        <Provider store={store}>
          <ThreadMoreActions threadId="t1" readOnly />
        </Provider>,
      ),
    ).not.toThrow()
  })
})
