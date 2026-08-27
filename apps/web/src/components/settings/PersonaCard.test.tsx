import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

mock.restore()

const getPersonaMock = mock(async () => ({
  markdown: '# Mason\n\n喜欢简洁、有温度的表达。',
  parsed: {
    preferences: ['简洁表达'],
    interactionRules: [],
    evolution: [],
  },
  updatedAt: '2026-08-01T00:00:00.000Z',
}))
const correctPersonaMock = mock(async (_input: { workspaceSlug: string; correction: string }) => ({
  ok: true as const,
}))
const regeneratePersonaMock = mock(async () => ({ ok: true as const }))

const toastSuccessMock = mock((_msg: string, _opts?: unknown) => undefined)
const toastErrorMock = mock((_msg: string, _opts?: unknown) => undefined)
const toastLoadingMock = mock((_msg: string) => 'toast-id')

mock.module('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    loading: toastLoadingMock,
  },
}))

mock.module('@/lib/desktop-api', () => ({
  // Persona — 实际被测对象
  getPersona: () => getPersonaMock(),
  correctPersona: (...args: unknown[]) => correctPersonaMock(...(args as [{ workspaceSlug: string; correction: string }])),
  regeneratePersona: () => regeneratePersonaMock(),
  // 其余 MemorySettings 模块加载时静态导入，但 PersonaCard 不依赖；统一 async stub。
  getMemoryRuntimeConfig: mock(async () => null),
  cancelMemoryJob: mock(async () => null),
  retryMemoryJob: mock(async () => null),
  getMemoryIngestJob: mock(async () => null),
  getMemoryOrganizeJob: mock(async () => null),
  getMemorySettingsSnapshot: mock(async () => null),
  getMemoryDiagnosticsSnapshot: mock(async () => null),
  ingestMemorySources: mock(async () => null),
  openFileDialog: mock(async () => ({ files: [] })),
  openFolderDialog: mock(async () => ({ path: null })),
  openMemorySource: mock(async () => undefined),
  organizeMemoryEntries: mock(async () => null),
  organizeMemoryHistory: mock(async () => null),
  readMemory: mock(async () => null),
  reloadLocalOnnxEmbedding: mock(async () => undefined),
  rememberMemory: mock(async () => undefined),
  deleteMemoryEntry: mock(async () => undefined),
  resolveMemoryPending: mock(async () => undefined),
  updateMemoryEntry: mock(async () => undefined),
  undoMemoryMutation: mock(async () => undefined),
  updateMemoryRuntimeConfig: mock(async () => null),
}))

const { PersonaCard } = await import('./MemorySettings')

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

function findButtonByText(node: FakeEventTarget, text: string): FakeElement | null {
  if (node instanceof FakeElement && node.tagName === 'BUTTON' && node.textContent?.includes(text)) {
    return node
  }
  for (const child of node.childNodes) {
    const result = findButtonByText(child, text)
    if (result) return result
  }
  return null
}

function findFirstTextarea(node: FakeEventTarget): FakeElement | null {
  if (node instanceof FakeElement && node.tagName === 'TEXTAREA') return node
  for (const child of node.childNodes) {
    const result = findFirstTextarea(child)
    if (result) return result
  }
  return null
}

describe('PersonaCard', () => {
  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    getPersonaMock.mockReset()
    correctPersonaMock.mockReset()
    regeneratePersonaMock.mockReset()
    toastSuccessMock.mockReset()
    toastErrorMock.mockReset()
    toastLoadingMock.mockReset()
    toastLoadingMock.mockImplementation(() => 'toast-id')
    getPersonaMock.mockImplementation(async () => ({
      markdown: '# 用户画像\n\n## 长期偏好\n- 喜欢简洁、有温度的表达。',
      parsed: { preferences: ['简洁表达'], interactionRules: [], evolution: [] },
      updatedAt: '2026-08-01T00:00:00.000Z',
    }))
    correctPersonaMock.mockImplementation(async () => ({ ok: true as const }))
    regeneratePersonaMock.mockImplementation(async () => ({ ok: true as const }))
  })

  afterEach(async () => {
    await flush()
  })

  test('generated state: shows status badge, markdown preview, correction and regenerate actions', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<PersonaCard workspaceSlug="workspace" />)
        await flush()
      })

      expect(getPersonaMock).toHaveBeenCalledTimes(1)
      expect(getPersonaMock).toHaveBeenCalledWith()
      expect(container.textContent).toContain('已生成')
      expect(container.textContent).toContain('关于我')
      // Markdown 主体可见
      expect(container.textContent).toContain('# 关于我')
      expect(container.textContent).not.toContain('# 用户画像')
      expect(container.textContent).toContain('喜欢简洁、有温度的表达。')
      // 默认折叠态：展开按钮可见
      expect(findButtonByText(container, '展开')).not.toBeNull()
      expect(findButtonByText(container, '纠正关于我')).not.toBeNull()
      expect(findButtonByText(container, '重新生成')).not.toBeNull()
      // 无错误 toast
      expect(toastErrorMock).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('expand toggle switches label between 展开 / 收起', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<PersonaCard workspaceSlug="workspace" />)
        await flush()
      })

      const expandBtn = findButtonByText(container, '展开')!
      expect(expandBtn).not.toBeNull()

      await act(async () => {
        expandBtn.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      // 展开后按钮文案切换为「收起」
      expect(findButtonByText(container, '收起')).not.toBeNull()
      expect(findButtonByText(container, '展开')).toBeNull()

      await act(async () => {
        findButtonByText(container, '收起')!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })
      expect(findButtonByText(container, '展开')).not.toBeNull()
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('derived Persona cannot be edited directly and correction starts disabled', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<PersonaCard workspaceSlug="workspace" />)
        await flush()
      })

      expect(findFirstTextarea(container)).toBeNull()
      expect(findButtonByText(container, '编辑')).toBeNull()
      const correctionButton = findButtonByText(container, '纠正关于我')!
      expect(correctionButton).not.toBeNull()
      expect(correctionButton.attributes.get('disabled')).toBeDefined()
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('regenerate button calls regeneratePersona and emits loading + success toast', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<PersonaCard workspaceSlug="workspace" />)
        await flush()
      })

      const regenerateBtn = findButtonByText(container, '重新生成')!
      await act(async () => {
        regenerateBtn.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(regeneratePersonaMock).toHaveBeenCalledWith()
      expect(toastLoadingMock).toHaveBeenCalledWith('正在重新生成关于我...')
      expect(toastSuccessMock).toHaveBeenCalledWith('关于我已重新生成', { id: 'toast-id' })
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('not-generated state: shows hint and keeps correction/regenerate actions', async () => {
    getPersonaMock.mockImplementation(async () => ({
      markdown: '',
      parsed: { preferences: [], interactionRules: [], evolution: [] },
      updatedAt: undefined,
    }))
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<PersonaCard workspaceSlug="workspace" />)
        await flush()
      })

      expect(container.textContent).toContain('未生成')
      expect(container.textContent).toContain('Lume 会基于你的长期记忆自动生成关于我')
      expect(findButtonByText(container, '编辑')).toBeNull()
      expect(findButtonByText(container, '展开')).toBeNull()
      expect(findButtonByText(container, '纠正关于我')).not.toBeNull()
      // 未生成态仍允许立即创建
      expect(findButtonByText(container, '重新生成')).not.toBeNull()
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('heading-only legacy markdown is not treated as generated content', async () => {
    getPersonaMock.mockImplementation(async () => ({
      markdown: '# 用户画像',
      parsed: { preferences: [], interactionRules: [], evolution: [] },
      updatedAt: '2026-08-01T00:00:00.000Z',
    }))
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<PersonaCard workspaceSlug="workspace" />)
        await flush()
      })

      expect(container.textContent).toContain('未生成')
      expect(findButtonByText(container, '展开')).toBeNull()
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('getPersona failure: shows error toast and falls back to not-generated', async () => {
    getPersonaMock.mockImplementation(async () => {
      throw new Error('boom')
    })
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<PersonaCard workspaceSlug="workspace" />)
        await flush()
      })

      expect(toastErrorMock).toHaveBeenCalled()
      expect(container.textContent).toContain('未生成')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })
})
