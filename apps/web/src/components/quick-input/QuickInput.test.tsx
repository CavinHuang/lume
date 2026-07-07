import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'

mock.restore()

// ===== mocks（必须在动态 import QuickInput 之前注册） =====
// brief 示例用 vitest；本仓库 web 端实际用 bun:test + 自建 fake DOM（无 jsdom / RTL），
// 因此按 AgentView.test.tsx 的既有模式重写：mock.module 拦截依赖、createRoot + act 渲染、
// 通过捕获 mock 组件的 props / 全局 listener 来驱动交互。

const createThreadMock = mock(
  async (workspaceId?: string) => ({ id: `thread-${workspaceId ?? 'none'}-1` }),
)
const invokeMock = mock(async (..._args: unknown[]) => undefined)

// 捕获 AgentView 拿到的 threadId（验证状态正确传给子组件）
let latestAgentViewThreadId: string | null = null
let latestAgentViewMessageMetadata: Record<string, unknown> | undefined
let latestAgentViewDesktopContextTarget: Record<string, unknown> | undefined
let latestAgentViewOnMessageMetadataConsumed: (() => void) | undefined

// 捕获 ui/Button 的 onClick + children 文本（fake DOM 无法触发真实 click，
// 改为 mock Button 后直接调用捕获的 handler，等同 AgentView.test.tsx 直接调 prop handler 的做法）
type CapturedButton = { onClick?: () => void; text: string }
const capturedButtons: CapturedButton[] = []

// 注意：bun:test 的 mock.module 是「进程级」共享的（跨文件不隔离，mock.restore() 也不撤销）。
// 其他测试文件（如 AgentView.test.tsx）也 mock 了 @/lib/desktop-api 但未导出 createThread，
// 会污染本文件对 createThread 的命名导入。按 bun 官方 issue #12823/#7823 的推荐做法，
// 这里 await mock.module 确保本文件的 factory 在动态 import 前已注册并覆盖。
await mock.module('@/lib/desktop-api', () => ({
  createThread: (...args: Parameters<typeof createThreadMock>) =>
    createThreadMock(...args),
}))
await mock.module('@/lib/desktop-runtime/core', () => ({
  invoke: (...args: Parameters<typeof invokeMock>) => invokeMock(...args),
}))
await mock.module('@/hooks/useGlobalAgentListeners', () => ({
  useGlobalAgentListeners: () => {},
}))
await mock.module('@/hooks/useWorkspaceBootstrap', () => ({
  useWorkspaceBootstrap: () => {},
}))
await mock.module('@/components/agent/AgentView', () => ({
  AgentView: ({
    threadId,
    messageMetadata,
    desktopContextTarget,
    onMessageMetadataConsumed,
  }: {
    threadId: string
    messageMetadata?: Record<string, unknown>
    desktopContextTarget?: Record<string, unknown>
    onMessageMetadataConsumed?: () => void
  }) => {
    latestAgentViewThreadId = threadId
    latestAgentViewMessageMetadata = messageMetadata
    latestAgentViewDesktopContextTarget = desktopContextTarget
    latestAgentViewOnMessageMetadataConsumed = onMessageMetadataConsumed
    return React.createElement('div', null, `thread:${threadId}`)
  },
}))
await mock.module('@/components/ui/button', () => ({
  Button: (props: { onClick?: () => void; children?: React.ReactNode }) => {
    const text = Array.isArray(props.children)
      ? props.children
          .map((c) => (typeof c === 'string' ? c : ''))
          .join('')
      : typeof props.children === 'string'
        ? props.children
        : ''
    capturedButtons.push({ onClick: props.onClick, text })
    return React.createElement('button', { type: 'button' }, props.children)
  },
}))
await mock.module('sonner', () => ({
  toast: { error: () => {}, success: () => {} },
}))

const { QuickInput } = await import('./QuickInput')

// ===== Fake DOM（参照 AgentView.test.tsx，增强 addEventListener 以捕获 document keydown） =====

class FakeEventTarget {
  parentNode: FakeEventTarget | null = null
  childNodes: FakeEventTarget[] = []
  protected listeners = new Map<string, Set<(e: unknown) => void>>()

  appendChild(node: FakeEventTarget) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }
  insertBefore(node: FakeEventTarget, before: FakeEventTarget | null) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    const i = before ? this.childNodes.indexOf(before) : -1
    if (i === -1) this.childNodes.push(node)
    else this.childNodes.splice(i, 0, node)
    return node
  }
  removeChild(node: FakeEventTarget) {
    const i = this.childNodes.indexOf(node)
    if (i >= 0) {
      this.childNodes.splice(i, 1)
      node.parentNode = null
    }
    return node
  }
  contains(target: unknown) {
    if (target === this) return true
    return this.childNodes.some((c) => c.contains(target))
  }
  addEventListener(type: string, h: (e: unknown) => void) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(h)
  }
  removeEventListener(type: string, h: (e: unknown) => void) {
    this.listeners.get(type)?.delete(h)
  }
  dispatchEvent(type: string, payload: unknown) {
    this.listeners.get(type)?.forEach((h) => h(payload))
  }
}

class FakeTextNode extends FakeEventTarget {
  readonly nodeType = 3
  ownerDocument: FakeDocument
  nodeValue: string
  data: string
  constructor(value: string, ownerDocument: FakeDocument) {
    super()
    this.ownerDocument = ownerDocument
    this.nodeValue = value
    this.data = value
  }
  get textContent() {
    return this.nodeValue
  }
  set textContent(v: string) {
    this.nodeValue = v
    this.data = v
  }
}

class FakeElement extends FakeEventTarget {
  readonly nodeType = 1
  ownerDocument: FakeDocument
  tagName: string
  nodeName: string
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  attributes = new Map<string, string>()
  style: Record<string, string> = {}
  constructor(tagName: string, ownerDocument: FakeDocument) {
    super()
    this.ownerDocument = ownerDocument
    this.tagName = tagName.toUpperCase()
    this.nodeName = this.tagName
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  setAttributeNS(_: string | null, name: string, value: string) {
    this.setAttribute(name, value)
  }
  removeAttribute(name: string) {
    this.attributes.delete(name)
  }
  focus() {}
  get textContent() {
    return this.childNodes.map((c: any) => c.textContent ?? '').join('')
  }
  set textContent(v: string) {
    this.childNodes = []
    if (v !== '') this.appendChild(this.ownerDocument.createTextNode(v))
  }
}

class FakeDocument extends FakeEventTarget {
  readonly nodeType = 9
  ownerDocument = this
  documentElement: FakeElement
  body: FakeElement
  defaultView: typeof globalThis
  activeElement: FakeElement
  constructor() {
    super()
    this.documentElement = new FakeElement('html', this)
    this.body = new FakeElement('body', this)
    this.defaultView = globalThis
    this.activeElement = this.body
    this.appendChild(this.documentElement)
    this.documentElement.appendChild(this.body)
  }
  createElement(tagName: string) {
    return new FakeElement(tagName, this)
  }
  createElementNS(_: string | null, tagName: string) {
    return new FakeElement(tagName, this)
  }
  createTextNode(value: string) {
    return new FakeTextNode(value, this)
  }
}

function installFakeDom() {
  const keys = [
    'IS_REACT_ACT_ENVIRONMENT',
    'document',
    'window',
    'self',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLIFrameElement',
    'Text',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'localStorage',
  ] as const
  const previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>()
  for (const key of keys) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  const document = new FakeDocument()
  const storage = new Map<string, string>()
  // 用 defineProperty 而非 Object.assign：bun:test 跨文件共享 globalThis，
  // 其他测试文件（如 AgentView.test.tsx）可能把这些 key 设成只读，Object.assign 会抛
  // "Attempted to assign to readonly property"。defineProperty 配合 configurable: true 可强制覆盖。
  const globals: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    document,
    window: globalThis,
    self: globalThis,
    navigator: { userAgent: 'bun' },
    Node: FakeEventTarget,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: class HTMLIFrameElement extends FakeElement {},
    Text: FakeTextNode,
    requestAnimationFrame: (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
  }
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    })
  }
  return {
    container: document.createElement('div'),
    cleanup: () => {
      for (const key of keys) {
        const d = previousDescriptors.get(key)
        if (d) Object.defineProperty(globalThis, key, d)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

function makeStore() {
  const store = createStore()
  store.set(agentWorkspacesAtom, [
    { id: 'ws-1', name: '默认', slug: 'default', createdAt: 1, updatedAt: 2 } as never,
  ])
  store.set(currentWorkspaceIdAtom, 'ws-1')
  return store
}

describe('QuickInput', () => {
  let fakeDoc: FakeDocument
  let cleanup: () => void
  let rootRef: { current: Root | null }

  beforeEach(() => {
    createThreadMock.mockClear()
    invokeMock.mockClear()
    latestAgentViewThreadId = null
    latestAgentViewMessageMetadata = undefined
    latestAgentViewDesktopContextTarget = undefined
    latestAgentViewOnMessageMetadataConsumed = undefined
    capturedButtons.length = 0
    const env = installFakeDom()
    fakeDoc = env.container.ownerDocument as unknown as FakeDocument
    cleanup = env.cleanup
    rootRef = { current: null }
  })

  afterEach(async () => {
    await act(async () => {
      rootRef.current?.unmount()
      rootRef.current = null
      await flush()
    })
    cleanup()
  })

  test('workspace 就绪后创建首个会话并渲染 AgentView', async () => {
    const store = makeStore()
    const container = fakeDoc.createElement('div')

    await act(async () => {
      const root = createRoot(container as never)
      rootRef.current = root
      root.render(
        <Provider store={store}>
          <QuickInput />
        </Provider>,
      )
      await flush()
    })

    // createThread 被调用且参数为 currentWorkspaceId
    expect(createThreadMock.mock.calls.some((c) => c[0] === 'ws-1')).toBe(true)
    // AgentView 拿到 createThread 返回的 threadId
    expect(latestAgentViewThreadId).toBe('thread-ws-1-1')
    expect(container.textContent).toContain('thread:thread-ws-1-1')
  })

  test('将主进程预捕获的桌面上下文绑定到下一条消息', async () => {
    invokeMock.mockImplementation(async (command: string) => (
      command === 'quick_input_get_context'
        ? {
            status: 'ok',
            snapshotId: 'snapshot-before-focus',
            app: { id: 'wechat.exe', name: '微信' },
            window: { id: 'win:wechat', title: '项目群' },
            capturedAt: 100,
          }
        : undefined
    ))
    const store = makeStore()
    const container = fakeDoc.createElement('div')

    await act(async () => {
      const root = createRoot(container as never)
      rootRef.current = root
      root.render(
        <Provider store={store}>
          <QuickInput />
        </Provider>,
      )
      await flush()
    })

    expect(latestAgentViewMessageMetadata).toEqual({
      desktopContextSnapshotId: 'snapshot-before-focus',
      desktopApp: { id: 'wechat.exe', name: '微信' },
      desktopWindow: { id: 'win:wechat', title: '项目群' },
    })
    expect(latestAgentViewDesktopContextTarget).toEqual({
      snapshotId: 'snapshot-before-focus',
      app: { id: 'wechat.exe', name: '微信' },
      window: { id: 'win:wechat', title: '项目群' },
      capturedAt: 100,
    })
    expect(container.textContent).toContain('已附加 微信')
  })

  test('桌面上下文作为会话绑定，发送后不会被当作一次性附件清掉', async () => {
    invokeMock.mockImplementation(async (command: string) => (
      command === 'quick_input_get_context'
        ? {
            status: 'ok',
            snapshotId: 'snapshot-conversation',
            app: { id: 'wechat.exe', name: '微信' },
            window: { id: 'win:wechat', title: '项目群' },
          }
        : undefined
    ))
    const store = makeStore()
    const container = fakeDoc.createElement('div')

    await act(async () => {
      const root = createRoot(container as never)
      rootRef.current = root
      root.render(
        <Provider store={store}>
          <QuickInput />
        </Provider>,
      )
      await flush()
    })

    await act(async () => {
      latestAgentViewOnMessageMetadataConsumed?.()
      await flush()
    })

    expect(latestAgentViewMessageMetadata?.desktopContextSnapshotId).toBe('snapshot-conversation')
    expect(container.textContent).toContain('已附加 微信')
  })

  test('点击「新建对话」按钮再次创建会话', async () => {
    const store = makeStore()
    const container = fakeDoc.createElement('div')

    await act(async () => {
      const root = createRoot(container as never)
      rootRef.current = root
      root.render(
        <Provider store={store}>
          <QuickInput />
        </Provider>,
      )
      await flush()
    })

    // 初始 effect 已触发一次 createThread
    expect(createThreadMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    createThreadMock.mockClear()

    // 通过 mock Button 捕获的 onClick 模拟点击「新建对话」
    const newThreadBtn = capturedButtons.find((b) => b.text.includes('新建对话'))
    expect(newThreadBtn).toBeDefined()
    await act(async () => {
      newThreadBtn!.onClick?.()
      await flush()
    })
    expect(createThreadMock.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('按 Esc 触发 quick_input_hide', async () => {
    const store = makeStore()
    const container = fakeDoc.createElement('div')

    await act(async () => {
      const root = createRoot(container as never)
      rootRef.current = root
      root.render(
        <Provider store={store}>
          <QuickInput />
        </Provider>,
      )
      await flush()
    })

    invokeMock.mockClear()
    await act(async () => {
      // 触发 QuickInput 在 document 上注册的 keydown 监听
      fakeDoc.dispatchEvent('keydown', { key: 'Escape' })
      await flush()
    })
    expect(
      invokeMock.mock.calls.some((c) => c[0] === 'quick_input_hide'),
    ).toBe(true)
  })
})
