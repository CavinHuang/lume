import { afterAll, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { bridgeWizardOpenAtom, bridgeWizardPluginAtom } from '@/atoms'
import type { GetMarketDetailResult, InstallMarketItemResult, PluginMarketItem } from '@lume/shared'

mock.restore()

mock.module('sonner', () => ({
  toast: {
    error: () => {},
    success: () => {},
  },
}))

// ============ desktop-api mock ============
// 组件 import 多个 desktop-api 导出；mock 整模块避免真实 IPC 副作用，
// 同时把 installMarketItem 暴露成 mock.fn 以便第 0 步安装测试断言调用次数。
const installMarketItemMock = mock(
  async (): Promise<InstallMarketItemResult> => ({
    kind: 'plugin',
    id: 'local:demo',
    version: '1.0.0',
    installed: true,
    enableState: 'workspace-enabled',
    diagnostics: [],
  }),
)
const installPluginPackageMock = mock(async () => ({
  status: 'installed' as const,
  hostName: 'com.lume.browser',
  hostPath: '/tmp/lume-chrome-host',
  manifestPath: '/tmp/com.lume.browser.json',
}))

mock.module('@/lib/desktop-api', () => ({
  checkBridgeStatus: async () => ({ ok: true, detail: 'ok' }),
  savePluginPackage: async () => ({ status: 'saved', savedPath: '/tmp/x' }),
  installPluginPackage: installPluginPackageMock,
  writeClipboardText: async () => undefined,
  getMarketDetail: async (): Promise<GetMarketDetailResult> => mockMarketDetailResult(),
  installMarketItem: installMarketItemMock,
}))

// ============ FakeDocument（必须在 import @base-ui/react 之前装好）============
// 关键约束：base-ui 的 `useIsoLayoutEffect` 在模块加载时按 `typeof document`
// 决定是 React.useLayoutEffect 还是 noop。如果 base-ui 在 document 装好前被
// 静态 import，所有 Dialog 内部的 layout effect 都是 noop，Portal 状态同步
// 静默失败 → Dialog 永远 mounted=false。所以 FakeDocument 类定义 + globalThis.document
// 赋值必须放在 `await import('./BridgeInstallWizard')` 之前。
//
// 另：base-ui Dialog/FloatingFocusManager/useScrollLock 走真实 DOM API
// （style.setProperty、hasAttribute、matches、getComputedStyle、children 等），
// 所以 FakeElement 需要把它们 stub 出来。
//
// 通过 react-dom 注入到 FakeElement 的 `__reactProps$<suffix>` 可以直接拿到
// 组件的 onClick，进而驱动「下一步」按钮推进向导步骤。

class FakeEventTarget {
  parentNode: FakeEventTarget | null = null
  childNodes: FakeEventTarget[] = []

  appendChild(node: FakeEventTarget) {
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  insertBefore(node: FakeEventTarget, before: FakeEventTarget | null) {
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
    node.parentNode = this
    const index = before ? this.childNodes.indexOf(before) : -1
    if (index === -1) {
      this.childNodes.push(node)
    } else {
      this.childNodes.splice(index, 0, node)
    }
    return node
  }

  removeChild(node: FakeEventTarget) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) {
      this.childNodes.splice(index, 1)
      node.parentNode = null
    }
    return node
  }

  contains(target: unknown) {
    if (target === this) return true
    return this.childNodes.some((child) => child.contains(target))
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

  set textContent(value: string) {
    this.nodeValue = value
    this.data = value
  }
}

class FakeCSSStyleDeclaration {
  private store: Record<string, string> = {}
  setProperty(name: string, value: string) {
    this.store[name] = value
  }
  getPropertyValue(name: string) {
    return this.store[name] ?? ''
  }
  removeProperty(name: string) {
    const v = this.store[name]
    delete this.store[name]
    return v ?? ''
  }
  get length() {
    return Object.keys(this.store).length
  }
  [key: string]: any
}

class FakeElement extends FakeEventTarget {
  readonly nodeType = 1
  ownerDocument: FakeDocument
  tagName: string
  nodeName: string
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  attributes = new Map<string, string>()
  style = new FakeCSSStyleDeclaration()
  shadowRoot = null

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

  hasAttribute(name: string) {
    return this.attributes.has(name)
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }

  querySelector(_: string) {
    return null
  }

  querySelectorAll(_: string) {
    return [] as FakeElement[]
  }

  matches(_: string) {
    return false
  }

  closest(_: string) {
    return null
  }

  cloneNode() {
    return new FakeElement(this.tagName, this.ownerDocument)
  }

  getElementsByClassName(_: string) {
    return [] as FakeElement[]
  }

  getElementsByTagName(_: string) {
    return [] as FakeElement[]
  }

  getBoundingClientRect() {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
      toJSON: () => ({}),
    }
  }

  get children() {
    return (this.childNodes as FakeEventTarget[]).filter((c) => (c as any).nodeType === 1) as FakeElement[]
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get lastElementChild() {
    const c = this.children
    return c[c.length - 1] ?? null
  }

  addEventListener() {}

  removeEventListener() {}

  focus() {}

  blur() {}

  click() {}

  get textContent() {
    return this.childNodes.map((child: any) => child.textContent ?? '').join('')
  }

  set textContent(value: string) {
    this.childNodes = []
    if (value !== '') {
      this.appendChild(this.ownerDocument.createTextNode(value))
    }
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

  addEventListener() {}

  removeEventListener() {}
}

// 必须在 import BridgeInstallWizard（→ @base-ui/react）之前装好。
const fakeDocument = new FakeDocument()
const storage = new Map<string, string>()
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  document: fakeDocument,
  window: globalThis,
  self: globalThis,
  navigator: { userAgent: 'bun' },
  Node: FakeEventTarget,
  Element: FakeElement,
  HTMLElement: FakeElement,
  HTMLIFrameElement: class HTMLIFrameElement extends FakeElement {},
  Text: FakeTextNode,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  getComputedStyle: () =>
    ({
      getPropertyValue: () => '',
      overflowY: 'visible',
    }) as any,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: (key: string) => {
      storage.delete(key)
    },
  },
})

const { BridgeInstallWizard } = await import('./BridgeInstallWizard')

// ============ Helpers ============

async function flush() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function bridgePlugin(): PluginMarketItem {
  return {
    id: 'local:demo', pluginId: 'demo', name: 'Demo', version: '1.0.0',
    catalogItemKey: 'catalog-demo',
    sourceType: 'local', trustLevel: 'trusted',
    installState: 'not-installed', enableState: 'not-installed',
    capabilities: { skillCount: 0, hookEvents: [], mcpServerNames: [], commandToolNames: [] },
    permissions: { filesystemRead: [], filesystemWrite: [], networkOutbound: [], mcpRegister: false, shellAllow: false, toolAllow: [], toolAsk: [], toolDeny: [], hookEvents: [], riskLabels: [] },
    marketplace: {
      setup: [
        {
          id: 'install-ext', title: '安装扩展', description: '加载已解包', kind: 'install',
          artifact: { path: './ext.zip', kind: 'chrome-extension' },
          targetApp: { kind: 'chrome', installHint: 'chrome://extensions' },
        },
        {
          id: 'install-host', title: '安装 Host', description: '自动安装', kind: 'install',
          artifact: { path: './host.exe', kind: 'native-binary' },
          installer: {
            kind: 'chrome-native-host',
            hostName: 'com.lume.browser',
            extensionId: 'abcdefghijklmnopabcdefghijklmnop',
            appServerUrl: 'ws://127.0.0.1:43127/browser',
          },
        },
      ],
    },
  }
}

// 安装成功后 mock 返回的 detail：plugin 状态为 installed，inspect 含 permissionsHash。
function mockMarketDetailResult(): GetMarketDetailResult {
  return {
    item: {
      kind: 'plugin',
      plugin: { ...bridgePlugin(), installState: 'installed', enableState: 'workspace-enabled' },
    },
    inspect: {
      kind: 'plugin',
      normalized: { pluginId: 'demo', name: 'Demo', version: '1.0.0' },
      permissionSummary: {
        filesystemRead: [], filesystemWrite: [], networkOutbound: [],
        mcpRegister: false, shellAllow: false,
        toolAllow: [], toolAsk: [], toolDeny: [], hookEvents: [], riskLabels: [],
      },
      permissionsHash: 'hash-demo-1',
      installState: 'installed',
      enableState: 'workspace-enabled',
      diagnostics: [],
    },
    diagnostics: [],
  }
}

// FakeElement 没有事件派发能力（addEventListener 是 noop），无法用真实 click
// 触发 React 合成事件。但 react-dom 会把组件 props 写到元素的 `__reactProps$<suffix>`
// 上，可以直接调用 onClick。
function findReactPropsSuffix(root: FakeElement): string | null {
  let suffix: string | null = null
  const walk = (n: any): void => {
    if (!n || suffix) return
    for (const k of Object.keys(n)) {
      const m = k.match(/^__reactProps\$(.+)$/)
      if (m) {
        suffix = m[1]
        return
      }
    }
    for (const c of n.childNodes ?? []) walk(c as FakeElement)
  }
  walk(root)
  return suffix
}

function findButtonOnClick(root: FakeElement, suffix: string, text: string): (() => void) | null {
  let handler: (() => void) | null = null
  const walk = (n: any): void => {
    if (!n || handler) return
    const props = n[`__reactProps$${suffix}`]
    if (props?.onClick && n.tagName === 'BUTTON') {
      const txt = n.textContent ?? ''
      if (txt === text) handler = props.onClick as () => void
    }
    for (const c of n.childNodes ?? []) walk(c as FakeElement)
  }
  walk(root)
  return handler
}

function bodyText() {
  return fakeDocument.body.textContent ?? ''
}

function resetBody() {
  fakeDocument.body.childNodes = []
}

// ============ Tests ============

describe('BridgeInstallWizard', () => {
  afterAll(() => {
    mock.restore()
  })

  test('open 时渲染步骤标题与保存按钮', async () => {
    resetBody()
    const container = fakeDocument.createElement('div')
    const store = createStore()
    store.set(bridgeWizardOpenAtom, true)
    store.set(bridgeWizardPluginAtom, bridgePlugin())

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <BridgeInstallWizard workspaceSlug="default" />
          </Provider>,
        )
        await flush()
      })

      // 向导默认在第 0 步（安装 Lume 插件）。点击「下一步」推进到第 1 步
      // （桥接扩展安装），那里才有「安装扩展」标题与「保存」按钮。
      const suffix = findReactPropsSuffix(fakeDocument.body)
      expect(suffix).not.toBeNull()
      const next = findButtonOnClick(fakeDocument.body, suffix!, '下一步')
      expect(next).not.toBeNull()
      await act(async () => {
        next!({ preventDefault() {}, stopPropagation() {} } as any)
        await flush()
      })

      // Portal 内容挂到 document.body（FakeDocument.body）
      expect(bodyText()).toContain('安装扩展')
      expect(bodyText()).toContain('保存')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
    }
  })

  test('未 open 时不渲染内容', async () => {
    resetBody()
    const container = fakeDocument.createElement('div')
    const store = createStore()
    store.set(bridgeWizardPluginAtom, bridgePlugin())
    // bridgeWizardOpenAtom 保持默认 false

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <BridgeInstallWizard workspaceSlug="default" />
          </Provider>,
        )
        await flush()
      })

      expect(bodyText()).not.toContain('安装扩展')
      expect(bodyText()).not.toContain('安装向导')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
    }
  })

  test('第 0 步点击「确认权限并安装」调用 installMarketItem 并推进到下一步', async () => {
    resetBody()
    installMarketItemMock.mockClear()
    installPluginPackageMock.mockClear()
    const container = fakeDocument.createElement('div')
    const store = createStore()
    store.set(bridgeWizardOpenAtom, true)
    store.set(bridgeWizardPluginAtom, bridgePlugin())

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <BridgeInstallWizard workspaceSlug="default" />
          </Provider>,
        )
        await flush()
      })

      const suffix = findReactPropsSuffix(fakeDocument.body)
      expect(suffix).not.toBeNull()
      const installBtn = findButtonOnClick(fakeDocument.body, suffix!, '确认权限并安装')
      expect(installBtn).not.toBeNull()

      await act(async () => {
        installBtn!({ preventDefault() {}, stopPropagation() {} } as any)
        await flush()
      })

      // installMarketItem 被调用一次，且向导推进到第 1 步（桥接扩展安装）
      expect(installMarketItemMock.mock.calls.length).toBe(1)
      expect(installPluginPackageMock).toHaveBeenCalledWith({
        workspaceSlug: 'default',
        catalogItemKey: 'catalog-demo',
        setupStepId: 'install-host',
      })
      expect(bodyText()).toContain('安装扩展')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
    }
  })
})
