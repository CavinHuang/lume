import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

mock.restore()

const writeClipboardTextMock = mock(async (_text: string) => undefined)
const toastSuccessMock = mock((_msg: string, _opts?: unknown) => undefined)
const toastErrorMock = mock((_msg: string, _opts?: unknown) => undefined)

mock.module('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}))

// base-ui Select 与被测行为无关，stub 掉以绕开 FakeDocument 装载时序坑
// （见 BridgeInstallWizard.test.tsx 顶部注释：useIsoLayoutEffect 按模块加载时的
// typeof document 决定实现）。
mock.module('@/components/ui/select', () => ({
  Select: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}))

const listLogFilesMock = mock(async () => ({
  directory: '/logs',
  files: [{ name: 'a.log', sizeBytes: 100, modifiedAt: '2026-09-01T00:00:00.000Z' }],
  totalFiles: 1,
  totalBytes: 100,
}))
const readLogFileMock = mock(async () => ({
  fileName: '*',
  totalLines: 1,
  matchedLines: 1,
  lines: [{ lineNumber: 1, level: 'info', text: 'hello log line' }],
}))

mock.module('@/lib/desktop-api', () => ({
  // 被测对象：日志行复制（#867）
  writeClipboardText: writeClipboardTextMock,
  // 渲染数据链：listLogFiles → 默认选中 '*'（全目录）→ readLogFile → LogLine
  listLogFiles: listLogFilesMock,
  readLogFile: readLogFileMock,
  // 默认 '*' 路径 liveFollowEligible=false，不会被调用；defensive no-op 防缺导出
  subscribeLiveLogs: mock(async () => () => {}),
  getDiagnosticStatus: mock(async () => ({ available: false })),
  getGeneralSettings: mock(async () => ({ logging: null })),
  // 其余静态导入占位，不参与本测试
  decryptDiagnosticContent: mock(async () => null),
  deleteDiagnosticContent: mock(async () => null),
  deleteLogs: mock(async () => null),
  exportLogs: mock(async () => null),
  openLogsDir: mock(async () => undefined),
  startDiagnosticCapture: mock(async () => null),
  stopDiagnosticCapture: mock(async () => null),
  updateGeneralSettings: mock(async () => null),
}))

const { LogSettings } = await import('./LogSettings')

class FakeEventTarget {
  parentNode: FakeEventTarget | null = null
  childNodes: FakeEventTarget[] = []
  listeners = new Map<string, Set<EventListener>>()

  appendChild(node: FakeEventTarget) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  insertBefore(node: FakeEventTarget, before: FakeEventTarget | null) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    const index = before ? this.childNodes.indexOf(before) : -1
    if (index === -1) this.childNodes.push(node)
    else this.childNodes.splice(index, 0, node)
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

  contains(target: unknown): boolean {
    if (target === this) return true
    return this.childNodes.some((child) => child.contains(target))
  }

  addEventListener(type: string, listener: EventListener) {
    const set = this.listeners.get(type) ?? new Set<EventListener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(event: Event) {
    Object.defineProperty(event, 'target', { value: (event as any).target ?? this, configurable: true })
    Object.defineProperty(event, 'currentTarget', { value: this, configurable: true })
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener.call(this, event)
    }
    if (event.bubbles && this.parentNode) {
      this.parentNode.dispatchEvent(event)
    }
    return !event.defaultPrevented
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
    return this.childNodes.map((child: any) => child.textContent ?? '').join('')
  }

  set textContent(value: string) {
    this.childNodes = []
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value))
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

  Object.assign(globalThis, {
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
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })

  return {
    container: document.createElement('div'),
    cleanup: () => {
      for (const key of keys) {
        const previousDescriptor = previousDescriptors.get(key)
        if (previousDescriptor) {
          Object.defineProperty(globalThis, key, previousDescriptor)
        } else {
          Reflect.deleteProperty(globalThis, key)
        }
      }
    },
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function findButtonByTitle(node: FakeEventTarget, title: string): FakeElement | null {
  if (node instanceof FakeElement && node.tagName === 'BUTTON' && node.attributes.get('title') === title) {
    return node
  }
  for (const child of node.childNodes) {
    const result = findButtonByTitle(child, title)
    if (result) return result
  }
  return null
}

describe('LogSettings 日志行复制（#867）', () => {
  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    writeClipboardTextMock.mockReset()
    writeClipboardTextMock.mockImplementation(async () => undefined)
    toastSuccessMock.mockReset()
    toastErrorMock.mockReset()
    listLogFilesMock.mockClear()
    readLogFileMock.mockClear()
  })

  afterEach(async () => {
    await flush()
  })

  async function renderLogs() {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    await act(async () => {
      root!.render(<LogSettings />)
      await flush()
    })
    return {
      container,
      unmount: async () => {
        await act(async () => {
          root?.unmount()
          root = null
          await flush()
        })
        cleanup()
      },
    }
  }

  test('复制成功：调用 writeClipboardText 并显示 ✓，不弹错误 toast', async () => {
    const { container, unmount } = await renderLogs()
    try {
      const copyBtn = findButtonByTitle(container, '复制此行')
      expect(copyBtn).not.toBeNull()

      await act(async () => {
        copyBtn!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(writeClipboardTextMock).toHaveBeenCalledWith('hello log line')
      expect(container.textContent).toContain('✓')
      expect(toastErrorMock).not.toHaveBeenCalled()
    } finally {
      await unmount()
    }
  })

  test('复制失败：弹出错误 toast 且不显示 ✓', async () => {
    writeClipboardTextMock.mockImplementation(async () => {
      throw new Error('boom')
    })
    const { container, unmount } = await renderLogs()
    try {
      const copyBtn = findButtonByTitle(container, '复制此行')
      expect(copyBtn).not.toBeNull()

      await act(async () => {
        copyBtn!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(toastErrorMock).toHaveBeenCalledWith('复制日志失败')
      expect(container.textContent).not.toContain('✓')
    } finally {
      await unmount()
    }
  })
})
