import { describe, expect, test, mock, beforeEach } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { useThreadActions } from './use-thread-actions'
import { agentThreadsAtom, tabsAtom, activeTabIdAtom } from '@/atoms'

// mock sidecarCall（捕获调用参数）
const sidecarCallMock = mock(() => Promise.resolve())
mock.module('@/lib/desktop-api', () => ({
  sidecarCall: sidecarCallMock,
  writeClipboardText: mock(() => Promise.resolve()),
  getThreadMessages: mock(() => Promise.resolve([])),
}))

// mock sonner toast（避免噪声）
mock.module('sonner', () => ({ toast: { error: mock(), success: mock() } }))

/** 渲染一个 Harness 捕获 hook 返回值（渲染期取值，不依赖 useEffect） */
function captureActions(threadId: string, store: ReturnType<typeof createStore>) {
  let captured: ReturnType<typeof useThreadActions> | null = null
  function Harness() {
    captured = useThreadActions(threadId)
    return null
  }
  renderToStaticMarkup(
    <Provider store={store}>
      <Harness />
    </Provider>,
  )
  return captured!
}

describe('useThreadActions', () => {
  beforeEach(() => sidecarCallMock.mockReset())

  test('togglePin 调用 toggle-pin-thread 并翻转 pinned', async () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: 'T', pinned: false }])
    const actions = captureActions('t1', store)
    await actions.togglePin()
    expect(sidecarCallMock).toHaveBeenCalledWith('agent:toggle-pin-thread', { threadId: 't1' })
    expect(store.get(agentThreadsAtom)[0].pinned).toBe(true)
  })

  test('rename 调用 update-thread-title 并更新 threads 与 tabs', async () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: '旧', pinned: false }])
    store.set(tabsAtom, [{ id: 't1', title: '旧', type: 'agent' }])
    const actions = captureActions('t1', store)
    await actions.rename('新标题')
    expect(sidecarCallMock).toHaveBeenCalledWith('agent:update-thread-title', { threadId: 't1', title: '新标题' })
    expect(store.get(agentThreadsAtom)[0].title).toBe('新标题')
    expect(store.get(tabsAtom)[0].title).toBe('新标题')
  })

  test('archive 调用 archive-thread，移除 thread/tab 并切走激活', async () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: 'T', pinned: false }])
    store.set(tabsAtom, [{ id: 't1', title: 'T', type: 'agent' }])
    store.set(activeTabIdAtom, 't1')
    const actions = captureActions('t1', store)
    await actions.archive()
    expect(sidecarCallMock).toHaveBeenCalledWith('agent:archive-thread', { threadId: 't1' })
    expect(store.get(agentThreadsAtom)).toHaveLength(0)
    expect(store.get(tabsAtom)).toHaveLength(0)
    expect(store.get(activeTabIdAtom)).toBeNull()
  })

  test('rename 空标题不发起请求', async () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: '原标题', pinned: false }])
    const actions = captureActions('t1', store)
    await actions.rename('   ')
    expect(sidecarCallMock).not.toHaveBeenCalled()
  })
})
