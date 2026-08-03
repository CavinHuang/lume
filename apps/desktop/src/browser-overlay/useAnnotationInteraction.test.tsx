import { describe, test, expect, mock } from 'bun:test'

// hook 依赖 electron 的 ipcRenderer（经 guest-state 的 createGuestBridge 间接），
// 但本测试直接 mock bridge 对象，不加载真实 createGuestBridge，故无需 mock electron。
// 仍注册共享 superset stub：bun:test 默认共享全局模式下 mock.module 首写胜出，
// 必须与其它测试注册同一 stub 以免命名导出缺失触发 SyntaxError。
import { electronMockStub } from '../../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)

const { useAnnotationInteraction } = await import('./useAnnotationInteraction')
import type { Rect } from './useAnnotationInteraction'
import { useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// 渲染一个宿主组件调用 hook，把返回的 InteractionState 暴露到 ref。
// 跟踪当前 root：下一次 renderHook 调用时先 unmount 上一个 root，
// 触发 useEffect cleanup，移除 document 捕获监听器——
// 否则各测试残留的监听器会跨测试泄漏（Task 34 起 onClick 调用 stopImmediatePropagation，
// 最早注册的泄漏监听器会抢占后续测试的事件）。
let activeRoot: ReturnType<typeof createRoot> | null = null
function renderHook<T>(useFn: () => T): { current: T } {
  if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  const ref: { current: T } = { current: null as unknown as T }
  function Probe(): ReactNode { ref.current = useFn(); return null }
  const container = document.createElement('div')
  document.body.append(container)
  activeRoot = createRoot(container)
  act(() => { activeRoot.render(<Probe />) })
  return ref
}

const baseOpts = {
  bridge: { send: mock(() => {}), getState: () => null, subscribe: () => () => {} },
  host: null,
  generation: 1,
  win: window,
} as const

describe('useAnnotationInteraction - 骨架', () => {
  test('browse 模式：click 不触发任何发送（mode guard，验证 effect 在 browse 模式不挂交互 listener）', () => {
    const send = mock(() => {})
    const ref = renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'browse', purpose: 'annotation',
    }))
    const target = document.createElement('button')
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 })) })
    expect(send).toHaveBeenCalledTimes(0)
    expect(ref.current.hoverRect).toBeNull()
    document.body.innerHTML = ''
  })

  test('卸载时清理监听器（重挂不重复触发）', () => {
    const send = mock(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    function Probe(): ReactNode {
      useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' })
      return null
    }
    let root = createRoot(container)
    act(() => { root.render(<Probe />) })
    const target = document.createElement('button'); document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })) })
    // Task 34 起 comment 模式首次 click 会发送 open-editor（计数 = 1）
    // 卸载后再次 dispatch 不应再触发（验证 listener cleanup：计数不应增加到 2）
    const countBeforeUnmount = send.mock.calls.length
    act(() => { root.unmount() })
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })) })
    expect(send.mock.calls.length).toBe(countBeforeUnmount) // 卸载后 0 增量
    expect(countBeforeUnmount).toBe(1)
    document.body.innerHTML = ''
  })

  test('comment 模式 pointermove：hoverRect 为目标元素 rect', () => {
    const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation' }))
    // 模拟一个页面元素（getBoundingClientRect 返回固定 rect）
    const target = document.createElement('div')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 10, y: 20, width: 100, height: 50, top: 20, left: 10, right: 110, bottom: 70, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 30 })) })
    expect(ref.current.hoverRect).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    document.body.innerHTML = ''
  })

  test('pointermove 命中 overlay 自身元素：hoverRect 不变（isOverlayTarget 排除）', () => {
    // host 必须连入 document，document 捕获阶段监听器才会触发（detached subtree 的事件路径不到 document）。
    const host = document.createElement('div'); document.body.append(host)
    const overlayEl = document.createElement('div'); host.append(overlayEl) // host.contains(overlayEl) = true
    const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation', host }))
    act(() => { overlayEl.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1, clientY: 1 })) })
    expect(ref.current.hoverRect).toBeNull() // listener 已触发，但 isOverlayTarget 命中提前返回
    document.body.innerHTML = ''
  })

  test('pointermove：cursorPos 为 clientX+14, clientY+14，钳制到视口', () => {
    const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation' }))
    const target = document.createElement('div'); document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 200 })) })
    expect(ref.current.cursorPos).toEqual({ x: 114, y: 214 })
    document.body.innerHTML = ''
  })

  test('cursorPos 钳制：clientX 超过 innerWidth-32 时限制到 innerWidth-32', () => {
    const orig = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true })
    try {
      const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation' }))
      const target = document.createElement('div'); document.body.append(target)
      act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500, clientY: 10 })) })
      expect(ref.current.cursorPos?.x).toBe(200 - 32) // = 168
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: orig, configurable: true })
    }
    document.body.innerHTML = ''
  })

  test('comment 模式 click 元素：发送 open-editor + element anchor', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation', generation: 7,
    }))
    const target = document.createElement('button')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 5, y: 6, width: 30, height: 40, top: 6, left: 5, right: 35, bottom: 46, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 })) })
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.type).toBe('open-editor')
    expect(payload.annotationId).toBeUndefined()
    expect(payload.purpose).toBe('annotation')
    const anchor = payload.anchor as Record<string, unknown>
    expect(anchor.kind).toBe('element')
    expect(anchor.generation).toBe(7)
    expect(anchor.rect).toEqual({ x: 5, y: 6, width: 30, height: 40 })
    document.body.innerHTML = ''
  })

  test('click 时存在文本选区：不发送（让 mouseup/text 流程接管）', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation',
    }))
    const target = document.createElement('div'); document.body.append(target)
    // 模拟有文本选区
    const origGetSelection = window.getSelection
    window.getSelection = (() => ({ toString: () => 'selected text', isCollapsed: false, rangeCount: 1 })) as unknown as typeof window.getSelection
    try {
      act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })) })
    } finally {
      window.getSelection = origGetSelection
    }
    expect(send).toHaveBeenCalledTimes(0)
    document.body.innerHTML = ''
  })

  test('comment 模式 mouseup 有文本选区：发送 open-editor + text anchor', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation', generation: 3,
    }))
    // 构造一个 range（rect 20,30,80,20）；startContainer/endContainer/startOffset/endOffset
    // 必须存在，否则 buildAnchor→rangeDescriptor 访问 startContainer.parentElement 抛错，send 永不触发
    const range = {
      commonAncestorContainer: document.body,
      startContainer: document.body,
      endContainer: document.body,
      startOffset: 0,
      endOffset: 5,
      getBoundingClientRect: () => ({ x: 20, y: 30, width: 80, height: 20, top: 30, left: 20, right: 100, bottom: 50, toJSON() {} }),
    } as unknown as Range
    const origGetSelection = window.getSelection
    window.getSelection = (() => ({ toString: () => 'hello', isCollapsed: false, rangeCount: 1, getRangeAt: () => range })) as unknown as typeof window.getSelection
    try {
      act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    } finally {
      window.getSelection = origGetSelection
    }
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.type).toBe('open-editor')
    expect(payload.annotationId).toBeUndefined()
    expect(payload.purpose).toBe('annotation')
    expect(payload.anchor).toMatchObject({ kind: 'text', generation: 3 })
    const anchor = payload.anchor as Record<string, unknown>
    expect(anchor.rect).toEqual({ x: 20, y: 30, width: 80, height: 20 })
    document.body.innerHTML = ''
  })

  test('mouseup 无文本选区：不发送', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' }))
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    expect(send).toHaveBeenCalledTimes(0)
  })

  test('comment 模式拖拽 ≥6px：发送 open-editor + region anchor，且不重复发送 click', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation', generation: 9,
    }))
    const target = document.createElement('div'); document.body.append(target)
    // pointerdown 起点
    act(() => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 })) })
    // pointerup 终点（拖出 100x50）
    act(() => { target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 110, clientY: 60, button: 0 })) })
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.anchor).toMatchObject({ kind: 'region', generation: 9 })
    expect(payload.anchor).toHaveProperty('rect')
    const rect = (payload.anchor as Record<string, unknown>).rect as Record<string, number>
    expect(rect.width).toBe(100)
    expect(rect.height).toBe(50)
    document.body.innerHTML = ''
  })

  test('拖拽 <6px（视为点击）：不发送 region，由 click 处理 element', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' }))
    const target = document.createElement('div')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 0, y: 0, width: 50, height: 50, top: 0, left: 0, right: 50, bottom: 50, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 })) })
    act(() => { target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 12, clientY: 11, button: 0 })) })
    // region 不发送
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).anchor && ((c[0] as Record<string, unknown>).anchor as Record<string, unknown>).kind === 'region')).toBe(false)
    document.body.innerHTML = ''
  })

  test('marker hover 120ms：preview 显示并发 preview-open；leave 260ms：隐藏并发 preview-close', () => {
    const send = mock(() => {})
    // 同步 win：setTimeout 立即执行（跳过真实 120/260ms 等待）
    const syncWin = {
      ...window,
      document: window.document,
      setTimeout: ((cb: () => void) => { cb(); return 0 }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      requestAnimationFrame: ((cb: () => void) => { cb(); return 0 }) as typeof requestAnimationFrame,
      cancelAnimationFrame: (() => {}) as typeof cancelAnimationFrame,
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
      MutationObserver: window.MutationObserver,
      innerWidth: 1000, innerHeight: 800,
    } as unknown as Window
    let markerCb: { enter: (b: string, id: string, r: Rect) => void; leave: () => void } | null = null
    // 通过暴露的回调接口模拟 marker 行为
    const ref = renderHook(() => {
      const interaction = useAnnotationInteraction({
        ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation', win: syncWin,
      })
      markerCb = interaction.marker // Task 37 在 InteractionState 加 marker 字段
      return interaction
    })
    act(() => { markerCb?.enter('评论正文', 'c1', { x: 100, y: 50, width: 24, height: 24 }) })
    expect(ref.current.preview).not.toBeNull()
    expect(ref.current.preview?.body).toBe('评论正文')
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'preview-open')).toBe(true)
    act(() => { markerCb?.leave() })
    expect(ref.current.preview).toBeNull()
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'preview-close')).toBe(true)
    document.body.innerHTML = ''
  })

  test('marker click：发送 open-editor + annotationId（编辑现有）', () => {
    const send = mock(() => {})
    let markerCb: { click: (id: string, anchor: Record<string, unknown>) => void } | null = null
    renderHook(() => {
      const interaction = useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' })
      markerCb = interaction.marker
      return interaction
    })
    act(() => { markerCb?.click('c1', { kind: 'element' }) })
    const payload = send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.type).toBe('open-editor')
    expect(payload.annotationId).toBe('c1')
    document.body.innerHTML = ''
  })

  test('comment 模式 ESC：发送 mode-changed browse', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'mode-changed')).toBe(true)
    const payload = send.mock.calls.find((c) => (c[0] as Record<string, unknown>).type === 'mode-changed')![0] as Record<string, unknown>
    expect(payload.mode).toBe('browse')
    document.body.innerHTML = ''
  })

  test('非 Escape 键：不发送 mode-changed', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'mode-changed')).toBe(false)
    document.body.innerHTML = ''
  })

  test('scroll：rAF 去重后清 hover/cursor', () => {
    const rafCbs: Array<() => void> = []
    const winListeners: Record<string, Array<(e: unknown) => void>> = {}
    const syncWin = {
      ...window, document: window.document,
      requestAnimationFrame: ((cb: () => void) => { rafCbs.push(cb); return rafCbs.length }) as typeof requestAnimationFrame,
      cancelAnimationFrame: (() => {}) as typeof cancelAnimationFrame,
      setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
      addEventListener: ((type: string, listener: (e: unknown) => void) => { (winListeners[type] ??= []).push(listener) }) as typeof window.addEventListener,
      removeEventListener: (() => {}) as typeof window.removeEventListener,
      MutationObserver: window.MutationObserver, innerWidth: 1000, innerHeight: 800,
    } as unknown as Window
    const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation', win: syncWin }))
    const target = document.createElement('div')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 1, y: 2, width: 3, height: 4, top: 2, left: 1, right: 4, bottom: 6, toJSON() {} }) })
    document.body.append(target)
    // pointermove 走真实 document 捕获（syncWin.document = window.document；target 连入 document.body）
    act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 2, clientY: 3 })) })
    expect(ref.current.hoverRect).not.toBeNull()
    // happy-dom 不传播 window 级 capture；直接调用记录到的 scroll listener 模拟 scroll 触发 schedule
    act(() => { (winListeners['scroll'] ?? []).forEach((fn) => fn(new Event('scroll'))) })
    act(() => { rafCbs.splice(0).forEach((cb) => cb()) })
    expect(ref.current.hoverRect).toBeNull()
    document.body.innerHTML = ''
  })
})

// Task 74：Alt 多选（Codex §1.3）——useAnnotationInteraction 监听 Alt（keydown/up）→
// bridge.send set-design-modifier-pressed；design 模式（activeDesignChange 存在）+ Alt + click
// 元素 → buildAnchor + bridge.send design-overlay-update additionalAnchors（追加）。
// host 是 additionalAnchors 单一来源；overlay 仅渲染 + 移除。
describe('useAnnotationInteraction - Alt 多选', () => {
  test('Alt keydown → bridge.send set-design-modifier-pressed true', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation',
    }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true })) })
    expect(send.mock.calls.some((c) => {
      const p = c[0] as Record<string, unknown>
      return p.type === 'set-design-modifier-pressed' && p.pressed === true
    })).toBe(true)
    document.body.innerHTML = ''
  })

  test('Alt keyup → bridge.send set-design-modifier-pressed false', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation',
    }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true })) })
    act(() => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true })) })
    expect(send.mock.calls.some((c) => {
      const p = c[0] as Record<string, unknown>
      return p.type === 'set-design-modifier-pressed' && p.pressed === false
    })).toBe(true)
    document.body.innerHTML = ''
  })

  test('Alt keydown repeat=true → 不重复发送（仅在首次按下上报）', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation',
    }))
    // 首次按下 → 发送一次
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true })) })
    // repeat → 不再发送
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', repeat: true, bubbles: true })) })
    const modifierCalls = send.mock.calls.filter((c) => (c[0] as Record<string, unknown>).type === 'set-design-modifier-pressed')
    expect(modifierCalls.length).toBe(1)
    document.body.innerHTML = ''
  })

  test('browse 模式：Alt keydown 不发送（mode guard）', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'browse', purpose: 'annotation',
    }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true })) })
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'set-design-modifier-pressed')).toBe(false)
    document.body.innerHTML = ''
  })

  test('design 模式 + Alt + click 元素 → bridge.send design-overlay-update additionalAnchors', () => {
    const designAnchor = { kind: 'element', url: 'https://example.com', generation: 1, framePath: [], rect: { x: 0, y: 0, width: 10, height: 10 } }
    const activeDesignChange = { id: 'dc1', anchor: designAnchor, declarations: [] }
    const send = mock(() => {})
    const getState = () => ({ activeDesignChange })
    renderHook(() => useAnnotationInteraction({
      ...baseOpts,
      bridge: { send, getState: getState as never, subscribe: () => () => {} },
      mode: 'comment', purpose: 'annotation',
    }))
    // Alt 按下（进入多选态）
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true })) })
    // click 元素
    const target = document.createElement('button')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 5, y: 6, width: 30, height: 40, top: 6, left: 5, right: 35, bottom: 46, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 })) })
    // 期望发送 design-overlay-update，且 group.additionalAnchors 是单元素数组
    const updateCall = send.mock.calls.find((c) => (c[0] as Record<string, unknown>).type === 'design-overlay-update')
    expect(updateCall).toBeTruthy()
    const payload = updateCall![0] as Record<string, unknown>
    const group = payload.group as Record<string, unknown>
    expect(group.id).toBe('dc1')
    expect(group.anchor).toBe(designAnchor)
    expect(Array.isArray(group.declarations)).toBe(true)
    expect(Array.isArray(group.additionalAnchors)).toBe(true)
    const additionalAnchors = group.additionalAnchors as Array<Record<string, unknown>>
    expect(additionalAnchors.length).toBe(1)
    expect(additionalAnchors[0]!.kind).toBe('element')
    expect(additionalAnchors[0]!.rect).toEqual({ x: 5, y: 6, width: 30, height: 40 })
    document.body.innerHTML = ''
  })

  test('design 模式 + Alt + click：不发送 open-editor（多选分流，不进新建流程）', () => {
    const designAnchor = { kind: 'element', url: 'https://example.com', generation: 1, framePath: [], rect: { x: 0, y: 0, width: 10, height: 10 } }
    const activeDesignChange = { id: 'dc1', anchor: designAnchor, declarations: [] }
    const send = mock(() => {})
    const getState = () => ({ activeDesignChange })
    renderHook(() => useAnnotationInteraction({
      ...baseOpts,
      bridge: { send, getState: getState as never, subscribe: () => () => {} },
      mode: 'comment', purpose: 'annotation',
    }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true })) })
    const target = document.createElement('button'); document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 2 })) })
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'open-editor')).toBe(false)
    document.body.innerHTML = ''
  })

  test('design 模式 + 无 Alt + click：保持 open-editor 流程（多选仅 Alt 触发）', () => {
    const designAnchor = { kind: 'element', url: 'https://example.com', generation: 1, framePath: [], rect: { x: 0, y: 0, width: 10, height: 10 } }
    const activeDesignChange = { id: 'dc1', anchor: designAnchor, declarations: [] }
    const send = mock(() => {})
    const getState = () => ({ activeDesignChange })
    renderHook(() => useAnnotationInteraction({
      ...baseOpts,
      bridge: { send, getState: getState as never, subscribe: () => () => {} },
      mode: 'comment', purpose: 'annotation',
    }))
    // 不按 Alt，直接 click
    const target = document.createElement('button')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })) })
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'open-editor')).toBe(true)
    document.body.innerHTML = ''
  })

  test('无 activeDesignChange（非 design 模式）+ Alt + click：走 open-editor（多选分流仅 design 模式生效）', () => {
    const send = mock(() => {})
    const getState = () => null
    renderHook(() => useAnnotationInteraction({
      ...baseOpts,
      bridge: { send, getState: getState as never, subscribe: () => () => {} },
      mode: 'comment', purpose: 'annotation',
    }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true })) })
    const target = document.createElement('button')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })) })
    // 无 design 模式 → 走 open-editor（即使 Alt 按下）
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'open-editor')).toBe(true)
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'design-overlay-update')).toBe(false)
    document.body.innerHTML = ''
  })

  test('Alt keyup 未先 keydown：不发送 false（防止与按下态不同步）', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation',
    }))
    // 未先按 down，直接 up → 不应误发 false（保持 host modifier 状态稳定）
    act(() => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true })) })
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'set-design-modifier-pressed')).toBe(false)
    document.body.innerHTML = ''
  })
})
