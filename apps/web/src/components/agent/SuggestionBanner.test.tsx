import { beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { suggestionsVersionAtom } from '@/atoms'
import type { SuggestionFeedback, SuggestionRecord } from '@lume/shared'

mock.restore()

// ── desktop-api/suggestion mock ────────────────────────────────────────────
const listSuggestionsMock = mock(async () => [] as SuggestionRecord[])
const actOnSuggestionMock = mock(async () => ({ ok: true as const }))

mock.module('@/lib/desktop-api/suggestion', () => ({
  listSuggestions: (...args: unknown[]) =>
    listSuggestionsMock(...(args as [SuggestionRecord['status']?])),
  actOnSuggestion: (...args: unknown[]) =>
    actOnSuggestionMock(...(args as [number, SuggestionFeedback])),
}))

// ── Button mock：捕获 onClick，绕过 fake DOM 不派发 React 合成事件 ────────
// 仿 AgentView.test.tsx 用 latestAgentInputProps 捕获子组件 props 的模式。
type CapturedButton = {
  action: string
  recordId: number
  onClick: () => void
  label: string
}
const capturedButtons: CapturedButton[] = []

mock.module('@/components/ui/button', () => ({
  Button: (props: {
    children?: React.ReactNode
    onClick?: () => void
    'data-suggestion-action'?: string
    'data-suggestion-record-id'?: number
    'aria-label'?: string
  }) => {
    const action = props['data-suggestion-action']
    const recordId = props['data-suggestion-record-id']
    if (action && typeof recordId === 'number' && typeof props.onClick === 'function') {
      capturedButtons.push({
        action,
        recordId,
        onClick: props.onClick,
        label:
          typeof props['aria-label'] === 'string'
            ? props['aria-label']
            : textOf(props.children),
      })
    }
    const children = Array.isArray(props.children) ? props.children : [props.children]
    return React.createElement(
      'button',
      {
        type: 'button',
        'data-suggestion-action': action,
        'data-suggestion-record-id': recordId,
        'aria-label': props['aria-label'],
      },
      ...children,
    )
  },
}))

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return ''
}

// ── fake DOM（仿 AgentView.test.tsx，仅保留 SuggestionBanner 所需最小集合）──
class FakeEventTarget {
  parentNode: FakeEventTarget | null = null
  childNodes: FakeEventTarget[] = []
  appendChild<T extends FakeEventTarget>(node: T): T {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }
  removeChild<T extends FakeEventTarget>(node: T): T {
    const i = this.childNodes.indexOf(node)
    if (i >= 0) {
      this.childNodes.splice(i, 1)
      node.parentNode = null
    }
    return node
  }
  contains(target: unknown): boolean {
    if (target === this) return true
    return this.childNodes.some((c) => c.contains(target))
  }
}

class FakeTextNode extends FakeEventTarget {
  readonly nodeType = 3 as const
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
  readonly nodeType = 1 as const
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
  addEventListener() {}
  removeEventListener() {}
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
  readonly nodeType = 9 as const
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
    HTMLIFrameElement: class extends FakeElement {},
    Text: FakeTextNode,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v)
      },
      removeItem: (k: string) => {
        storage.delete(k)
      },
    },
  })
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

const { SuggestionBanner, SUGGESTION_EXPIRY_MS } = await import('./SuggestionBanner')

function makeRecord(overrides: Partial<SuggestionRecord> = {}): SuggestionRecord {
  return {
    id: 1,
    duplicateKey: 'k1',
    kind: 'followup',
    title: '建议标题',
    reason: '原因是这样',
    evidence: '一段证据',
    rawConfidence: 0.5,
    action: { type: 'open_memory_board' },
    status: 'suggested',
    createdAt: Date.now(),
    threadId: 'thread-1',
    workspaceSlug: 'ws',
    ...overrides,
  }
}

async function render(props: {
  threadId: string
  workspaceSlug?: string
  store?: ReturnType<typeof createStore>
}) {
  const env = installFakeDom()
  const store = props.store ?? createStore()
  const root: Root | null = createRoot(env.container as never)
  await act(async () => {
    root!.render(
      <Provider store={store}>
        <SuggestionBanner threadId={props.threadId} workspaceSlug={props.workspaceSlug} />
      </Provider>,
    )
    await flush()
  })
  return { ...env, store, root }
}

async function unmount(env: { root: Root | null }) {
  await act(async () => {
    env.root?.unmount()
    env.root = null
    await flush()
  })
}

function uniqueActionsFor(recordId: number): string[] {
  return Array.from(
    new Set(capturedButtons.filter((b) => b.recordId === recordId).map((b) => b.action)),
  ).sort()
}

describe('SuggestionBanner', () => {
  beforeEach(() => {
    listSuggestionsMock.mockReset()
    actOnSuggestionMock.mockReset()
    listSuggestionsMock.mockResolvedValue([])
    actOnSuggestionMock.mockResolvedValue({ ok: true as const })
    capturedButtons.length = 0
  })

  test('无建议时不渲染任何容器', async () => {
    listSuggestionsMock.mockResolvedValueOnce([])
    const env = await render({ threadId: 'thread-1', workspaceSlug: 'ws' })
    try {
      expect(env.container.childNodes.length).toBe(0)
      expect(env.container.textContent).toBe('')
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('有建议时渲染三态按钮（接受/忽略/不再建议）+ 标题/原因/依据', async () => {
    listSuggestionsMock.mockResolvedValueOnce([makeRecord({ id: 7 })])
    const env = await render({ threadId: 'thread-1', workspaceSlug: 'ws' })
    try {
      const text = env.container.textContent ?? ''
      expect(text).toContain('建议标题')
      expect(text).toContain('原因是这样')
      expect(text).toContain('依据：一段证据')
      expect(uniqueActionsFor(7)).toEqual(['accepted', 'ignored', 'never'])
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('点击忽略 → actOnSuggestion(id, "ignored") 被调 + 触发 listSuggestions 重拉 + banner 消失', async () => {
    listSuggestionsMock
      .mockResolvedValueOnce([makeRecord({ id: 9 })])
      .mockResolvedValueOnce([]) // act 后重拉返回空
    const env = await render({ threadId: 'thread-1', workspaceSlug: 'ws' })
    try {
      const callsBefore = listSuggestionsMock.mock.calls.length
      const ignoreBtn = capturedButtons.find((b) => b.recordId === 9 && b.action === 'ignored')
      expect(ignoreBtn).toBeDefined()

      await act(async () => {
        ignoreBtn!.onClick()
        await flush()
      })

      expect(actOnSuggestionMock).toHaveBeenCalledWith(9, 'ignored')
      expect(listSuggestionsMock.mock.calls.length).toBeGreaterThan(callsBefore)
      // act 后 banner 消失
      expect(env.container.childNodes.length).toBe(0)
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('会话隔离：仅渲染匹配 threadId + workspaceSlug 的建议', async () => {
    listSuggestionsMock.mockResolvedValueOnce([
      makeRecord({ id: 1, threadId: 'thread-1', workspaceSlug: 'ws', title: '命中' }),
      makeRecord({ id: 2, threadId: 'thread-2', workspaceSlug: 'ws', title: '他线程' }),
      makeRecord({ id: 3, threadId: 'thread-1', workspaceSlug: 'other', title: '他工作区' }),
    ])
    const env = await render({ threadId: 'thread-1', workspaceSlug: 'ws' })
    try {
      const text = env.container.textContent ?? ''
      expect(text).toContain('命中')
      expect(text).not.toContain('他线程')
      expect(text).not.toContain('他工作区')
      expect(Array.from(new Set(capturedButtons.map((b) => b.recordId)))).toEqual([1])
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('workspaceSlug=undefined 时仅匹配 workspaceSlug 缺失的记录', async () => {
    listSuggestionsMock.mockResolvedValueOnce([
      makeRecord({ id: 1, threadId: 'thread-1', workspaceSlug: undefined, title: '无工作区' }),
      makeRecord({ id: 2, threadId: 'thread-1', workspaceSlug: 'ws', title: '有工作区' }),
    ])
    const env = await render({ threadId: 'thread-1' })
    try {
      const text = env.container.textContent ?? ''
      expect(text).toContain('无工作区')
      expect(text).not.toContain('有工作区')
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('过期（>24h）不展示', async () => {
    listSuggestionsMock.mockResolvedValueOnce([
      makeRecord({
        id: 1,
        createdAt: Date.now() - SUGGESTION_EXPIRY_MS - 60_000,
        title: '陈旧',
      }),
      makeRecord({ id: 2, createdAt: Date.now() - 1000, title: '新鲜' }),
    ])
    const env = await render({ threadId: 'thread-1', workspaceSlug: 'ws' })
    try {
      const text = env.container.textContent ?? ''
      expect(text).not.toContain('陈旧')
      expect(text).toContain('新鲜')
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('suggestionsVersionAtom 版本号变化 → 触发 listSuggestions 重拉', async () => {
    const store = createStore()
    listSuggestionsMock.mockResolvedValue([])
    const env = await render({ threadId: 'thread-1', workspaceSlug: 'ws', store })
    try {
      const callsBefore = listSuggestionsMock.mock.calls.length
      await act(async () => {
        store.set(suggestionsVersionAtom, 1)
        await flush()
      })
      expect(listSuggestionsMock.mock.calls.length).toBeGreaterThan(callsBefore)
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })
})
