import { describe, test, expect, mock } from 'bun:test'

// 测试 harness：共享 superset stub 的 ipcRenderer.on 将 handler 记入 ipcRendererHandlers
// （见 scripts/test-electron-mock.ts）。后续 pushSync 从中取出 createGuestBridge 注册的
// 'lume:browser-annotation-guest' handler 直接调用，模拟主进程经 ipcRenderer 推送 sync 消息
// （含 activeDraft）。不依赖 production 代码暴露任何测试专用钩子（如 __lumeGuestHandler）。
import { electronMockStub, ipcRendererHandlers } from '../../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
const { AnnotationOverlay } = await import('./AnnotationOverlay')
const { createGuestBridge } = await import('./guest-state')

// 模拟主进程 sync 推送：调用 createGuestBridge 内部注册的 ipcRenderer.on handler
function pushSync(payload: Record<string, unknown>): void {
  ipcRendererHandlers.get('lume:browser-annotation-guest')?.({}, payload)
}

// 跟踪当前 root：每次 mount 前 unmount 上一个 root，触发 useEffect cleanup
// （避免残留监听器跨测试泄漏）。
let activeRoot: ReturnType<typeof createRoot> | null = null
function mount(host: HTMLElement): { send: ReturnType<typeof mock> } {
  if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  const send = mock(() => {})
  const bridge = createGuestBridge()
  bridge.send = send
  activeRoot = createRoot(host)
  act(() => { activeRoot.render(<AnnotationOverlay bridge={bridge} host={host} /> as ReactNode) })
  return { send }
}

describe('AnnotationOverlay EditorCard 接线', () => {
  test('activeDraft 到达 → 渲染 EditorCard；target=create（无 id），body 来自 activeDraft.body', () => {
    const host = document.createElement('div'); document.body.append(host)
    mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDraft: { anchor: { rect: { x: 10, y: 20, width: 30, height: 40 } }, body: 'draft' },
      })
    })
    const input = host.querySelector('input.editor-input') as HTMLInputElement | null
    expect(input).toBeTruthy()
    expect(input?.value).toBe('draft')
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })

  test('activeDraft 消失 → EditorCard 卸载', () => {
    const host = document.createElement('div'); document.body.append(host)
    mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDraft: { anchor: { rect: { x: 10, y: 20, width: 30, height: 40 } }, body: 'd' },
      })
    })
    expect(host.querySelector('input.editor-input')).toBeTruthy()
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
      })
    })
    expect(host.querySelector('input.editor-input')).toBeFalsy()
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })
})
