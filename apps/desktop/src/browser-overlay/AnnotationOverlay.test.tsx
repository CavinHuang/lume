import { describe, test, expect, mock } from 'bun:test'

// 测试 harness：共享 superset stub 的 ipcRenderer.on 将 handler 记入 ipcRendererHandlers
// （见 scripts/test-electron-mock.ts）。后续 pushSync 从中取出 createGuestBridge 注册的
// 'lume:browser-annotation-guest' handler 直接调用，模拟主进程经 ipcRenderer 推送 sync 消息
// （含 activeDraft / activeDesignChange）。不依赖 production 代码暴露任何测试专用钩子（如 __lumeGuestHandler）。
import { electronMockStub, ipcRendererHandlers } from '../../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
const { AnnotationOverlay } = await import('./AnnotationOverlay')
const { createGuestBridge } = await import('./guest-state')

// design 用 anchor（满足 AgentBrowserAnchor 必填字段）
const designAnchor = {
  kind: 'element',
  url: 'https://example.com',
  generation: 1,
  framePath: [],
  rect: { x: 10, y: 20, width: 30, height: 40 },
}

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

describe('AnnotationOverlay DesignEditor 接线', () => {
  test('activeDesignChange 到达 → 渲染 DesignEditor（含 declaration 输入）', () => {
    const host = document.createElement('div'); document.body.append(host)
    mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDesignChange: {
          id: 'dc1',
          anchor: designAnchor,
          declarations: [
            { property: 'color', value: 'red', previousValue: 'blue' },
            { property: 'fontSize', value: '16px', previousValue: '14px' },
          ],
        },
      })
    })
    // DesignEditor 标题 + DeclarationInput 输入（color picker + color text + px number）
    expect(host.querySelector('.design-editor-title')?.textContent).toBe('设计')
    expect(host.querySelector('input[type="color"]')).toBeTruthy()
    expect(host.querySelector('input.decl-color-text')).toBeTruthy()
    // EditorCard 不应同时渲染（互斥：activeDraft 不在）
    expect(host.querySelector('input.editor-input')).toBeFalsy()
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })

  test('DesignEditor 提交 → bridge.send({type:"design-overlay-update", group})', () => {
    const host = document.createElement('div'); document.body.append(host)
    const { send } = mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDesignChange: {
          id: 'dc1',
          anchor: designAnchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        },
      })
    })
    const submitBtn = host.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload.type).toBe('design-overlay-update')
    const group = payload.group as Record<string, unknown>
    expect(group.id).toBe('dc1')
    expect(group.anchor).toBe(designAnchor)
    expect(Array.isArray(group.declarations)).toBe(true)
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })

  test('hold-to-view pointerdown → bridge.send set-original-view-enabled(true)', () => {
    const host = document.createElement('div'); document.body.append(host)
    const { send } = mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDesignChange: {
          id: 'dc1',
          anchor: designAnchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        },
      })
    })
    const holdBtn = host.querySelector('button.design-editor-hold') as HTMLButtonElement
    // happy-dom 未暴露全局 PointerEvent：从 fiber 取 onPointerDown prop 直接调用（handler 忽略事件对象）
    const propsKey = Object.keys(holdBtn).find((k) => k.startsWith('__reactProps$'))!
    const onPointerDown = ((holdBtn as unknown as Record<string, unknown>)[propsKey] as Record<string, unknown>).onPointerDown as () => void
    act(() => onPointerDown())
    const payload = send.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload.type).toBe('set-original-view-enabled')
    expect(payload.enabled).toBe(true)
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })

  test('删除按钮 → bridge.send({type:"design-overlay-delete", groupId:"dc1"})', () => {
    const host = document.createElement('div'); document.body.append(host)
    const { send } = mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDesignChange: {
          id: 'dc1',
          anchor: designAnchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        },
      })
    })
    const delBtn = host.querySelector('button.design-editor-delete') as HTMLButtonElement
    act(() => delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload.type).toBe('design-overlay-delete')
    expect(payload.groupId).toBe('dc1')
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })

  test('activeDesignChange 消失 → DesignEditor 卸载', () => {
    const host = document.createElement('div'); document.body.append(host)
    mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDesignChange: {
          id: 'dc1',
          anchor: designAnchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        },
      })
    })
    expect(host.querySelector('.design-editor-title')).toBeTruthy()
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
      })
    })
    expect(host.querySelector('.design-editor-title')).toBeFalsy()
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })

  // 回归测试：close-editor 对称性。锁定 design→clear→draft 序列 bug：
  // activeDesignChange 消失时若无 else close-editor，editor 残留 editing design；
  // 后续 activeDraft 的 restore-editor(comment) 被 reducer 抗打断（prev.type==='editing'）→
  // EditorCard 仍以 design 目标渲染（错误）。对称 close-editor 让 editor 回 idle，
  // 后续 restore-editor(comment) 正确生效。
  test('design→clear→draft 序列 → EditorCard 以 edit 目标渲染（非 design）', () => {
    const host = document.createElement('div'); document.body.append(host)
    mount(host)
    // 1. activeDesignChange 到 → restore-editor design → editing design
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDesignChange: {
          id: 'dc1',
          anchor: designAnchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        },
      })
    })
    expect(host.querySelector('.design-editor-title')).toBeTruthy()
    // 2. 清空（design 与 draft 均无）→ editor 应回 idle（close-editor）
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
      })
    })
    expect(host.querySelector('.design-editor-title')).toBeFalsy()
    expect(host.querySelector('input.editor-input')).toBeFalsy()
    // 3. activeDraft 到（带 id → edit）→ restore-editor comment → editing edit
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDraft: { id: 'c1', anchor: { rect: { x: 10, y: 20, width: 30, height: 40 } }, body: 'hi' },
      })
    })
    // 4. EditorCard 渲染（edit 目标，canDelete=true）；DesignEditor 不渲染
    const input = host.querySelector('input.editor-input') as HTMLInputElement | null
    expect(input).toBeTruthy()
    expect(input?.value).toBe('hi')
    expect(host.querySelector('.design-editor-title')).toBeFalsy()
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })

  // Task 74：Alt 多选（Codex §1.3）——AnnotationOverlay 接线。
  // activeDesignChange.additionalAnchors 透传 DesignEditor 渲染；
  // 点击 × → bridge.send remove-annotation-selection{selectionIndex}。
  test('activeDesignChange.additionalAnchors → 渲染选区列表 + remove 按钮', () => {
    const host = document.createElement('div'); document.body.append(host)
    mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDesignChange: {
          id: 'dc1',
          anchor: designAnchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
          additionalAnchors: [
            { kind: 'element', url: 'https://example.com', generation: 1, framePath: [], selector: '#a2', rect: { x: 50, y: 60, width: 30, height: 40 } },
            { kind: 'element', url: 'https://example.com', generation: 1, framePath: [], selector: '#a3', rect: { x: 70, y: 80, width: 30, height: 40 } },
          ],
        },
      })
    })
    // 两条 selection
    expect(host.querySelectorAll('[data-selection-index]').length).toBe(2)
    expect(host.querySelector('.design-selections')).toBeTruthy()
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })

  test('点击 remove 按钮 → bridge.send remove-annotation-selection{selectionIndex}', () => {
    const host = document.createElement('div'); document.body.append(host)
    const { send } = mount(host)
    act(() => {
      pushSync({
        type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation',
        comments: [],
        activeDesignChange: {
          id: 'dc1',
          anchor: designAnchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
          additionalAnchors: [
            { kind: 'element', url: 'https://example.com', generation: 1, framePath: [], selector: '#a2', rect: { x: 50, y: 60, width: 30, height: 40 } },
          ],
        },
      })
    })
    const removeBtn = host.querySelector('button.design-selection-remove') as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    act(() => removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const removeCall = send.mock.calls.find((c) => (c[0] as Record<string, unknown>).type === 'remove-annotation-selection')
    expect(removeCall).toBeTruthy()
    expect((removeCall![0] as Record<string, unknown>).selectionIndex).toBe(0)
    document.body.innerHTML = ''
    if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  })
})
