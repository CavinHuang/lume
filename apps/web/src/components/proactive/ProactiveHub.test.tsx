import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import {
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  memoryCenterDeepLinkAtom,
  suggestionsVersionAtom,
} from '@/atoms'
import type {
  MemorySettingsSnapshot,
  SuggestionFeedback,
  SuggestionRecord,
  SuggestionStats,
} from '@lume/shared'

mock.restore()

// ── data source mocks ───────────────────────────────────────────────────────
const listSuggestionsMock = mock(async () => [] as SuggestionRecord[])
const actOnSuggestionMock = mock(async () => ({ ok: true as const }))
const deleteSuggestionMock = mock(async () => ({ ok: true as const }))
const getSuggestionStatsMock = mock(async () => emptyStats())
const runSuggestionAnalysisMock = mock(async () => ({ added: 0 }))

mock.module('@/lib/desktop-api/suggestion', () => ({
  listSuggestions: (...args: unknown[]) =>
    listSuggestionsMock(...(args as [SuggestionRecord['status']?])),
  actOnSuggestion: (...args: unknown[]) =>
    actOnSuggestionMock(...(args as [number, SuggestionFeedback])),
  deleteSuggestion: (...args: unknown[]) =>
    deleteSuggestionMock(...(args as [number])),
  getSuggestionStats: () => getSuggestionStatsMock(),
  runSuggestionAnalysis: (...args: unknown[]) =>
    runSuggestionAnalysisMock(...(args as [string?])),
}))

const getMemorySettingsSnapshotMock = mock(
  async () => null as MemorySettingsSnapshot | null,
)
const resolveMemoryPendingMock = mock(async () => ({ ok: true as const }))
mock.module('@/lib/desktop-api/memory-center', () => ({
  getMemorySettingsSnapshot: (...args: unknown[]) =>
    getMemorySettingsSnapshotMock(...(args as [string])),
  resolveMemoryPending: (...args: unknown[]) => resolveMemoryPendingMock(...args),
}))

const toastSuccessMock = mock((_msg: string) => undefined)
const toastErrorMock = mock((_msg: string) => undefined)
mock.module('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccessMock(msg),
    error: (msg: string) => toastErrorMock(msg),
  },
}))

// ── Button mock：捕获 onClick（仿 AgentView/SuggestionBanner test 的 props 捕获模式）──
type CapturedClick = { key: string; onClick: () => void; disabled?: boolean }
const capturedClicks: CapturedClick[] = []

function captureKey(props: Record<string, unknown>): string {
  // data-suggestion-action="<action>" + data-suggestion-record-id=<id> → "action:id"
  const action = props['data-suggestion-action']
  if (action !== undefined) {
    const recordId = props['data-suggestion-record-id']
    return recordId !== undefined ? `${action}:${recordId}` : String(action)
  }
  // data-suggestion-delete=<id> → "delete:id"
  const del = props['data-suggestion-delete']
  if (del !== undefined) return `delete:${del}`
  // data-proactive-analyze / data-proactive-open-memory → 布尔标记
  if (props['data-proactive-analyze'] !== undefined) return 'analyze'
  if (props['data-memory-center-section'] !== undefined) return `section:${props['data-memory-center-section']}`
  if (props['data-memory-pending-action'] !== undefined) return `pending:${props['data-memory-pending-action']}:${props['data-memory-pending-id']}`
  return ''
}

mock.module('@/components/ui/button', () => ({
  Button: (props: {
    children?: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    [key: string]: unknown
  }) => {
    const key = captureKey(props)
    if (key && typeof props.onClick === 'function') {
      capturedClicks.push({
        key,
        onClick: props.onClick,
        disabled: props.disabled,
      })
    }
    const children = Array.isArray(props.children)
      ? props.children
      : [props.children]
    return React.createElement(
      'button',
      {
        type: 'button',
        'data-captured': key || undefined,
        disabled: props.disabled,
      },
      ...children,
    )
  },
}))

// ── fake DOM（仿 AgentView.test.tsx / SuggestionBanner.test.tsx）─────────────
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
  const previousDescriptors = new Map<
    PropertyKey,
    PropertyDescriptor | undefined
  >()
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
    requestAnimationFrame: (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle),
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

const { ProactiveHub } = await import('./ProactiveHub')

// ── fixture builders ────────────────────────────────────────────────────────
function emptyStats(): SuggestionStats {
  return {
    suggestedCount: 0,
    todayAccepted: 0,
    todayIgnored: 0,
    todayNever: 0,
    typeWeights: {
      correction: 1,
      followup: 1,
      automation: 1,
      todo: 1,
      skill: 1,
    },
  }
}

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
    ...overrides,
  }
}

function makeSnapshot(
  overrides: Partial<MemorySettingsSnapshot> = {},
): MemorySettingsSnapshot {
  return {
    workspaceSlug: 'ws',
    counts: {
      active: 12,
      workspace: 5,
      global: 7,
      suspectedStale: 0,
      pinned: 0,
      daily: 0,
      runs: 0,
      pending: { conflicts: 1, stale: 0, lowConfidence: 0, total: 1 },
    },
    files: [],
    workspaceEntries: [],
    globalEntries: [],
    pending: [],
    extraction: { source: 'disabled', message: '' },
    retrieval: {
      semantic: { message: '', mode: 'auto' },
    } as MemorySettingsSnapshot['retrieval'],
    ...overrides,
  }
}

async function render(options?: {
  store?: ReturnType<typeof createStore>
  onOpenMemorySettings?: () => void
}) {
  const env = installFakeDom()
  const store = options?.store ?? createStore()
  const root: Root | null = createRoot(env.container as never)
  await act(async () => {
    root!.render(
      <Provider store={store}>
        <ProactiveHub onOpenMemorySettings={options?.onOpenMemorySettings} />
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

function clicksFor(keyPart: string): CapturedClick[] {
  return capturedClicks.filter(
    (c) => c.key === keyPart || c.key.startsWith(`${keyPart}:`),
  )
}

/** 去重：同一 data-* 标记的按钮每次 re-render 都会被捕获，按 key 去重后计数。 */
function uniqueKeys(keyPart: string): string[] {
  return Array.from(
    new Set(
      clicksFor(keyPart).map((c) => c.key),
    ),
  )
}

describe('ProactiveHub', () => {
  beforeEach(() => {
    listSuggestionsMock.mockReset()
    listSuggestionsMock.mockResolvedValue([])
    actOnSuggestionMock.mockReset()
    actOnSuggestionMock.mockResolvedValue({ ok: true as const })
    deleteSuggestionMock.mockReset()
    deleteSuggestionMock.mockResolvedValue({ ok: true as const })
    getSuggestionStatsMock.mockReset()
    getSuggestionStatsMock.mockResolvedValue(emptyStats())
    runSuggestionAnalysisMock.mockReset()
    runSuggestionAnalysisMock.mockResolvedValue({ added: 0 })
    getMemorySettingsSnapshotMock.mockReset()
    getMemorySettingsSnapshotMock.mockResolvedValue(null)
    resolveMemoryPendingMock.mockReset()
    resolveMemoryPendingMock.mockResolvedValue({ ok: true as const })
    toastSuccessMock.mockReset()
    toastErrorMock.mockReset()
    capturedClicks.length = 0
  })

  afterEach(async () => {
    await flush()
  })

  test('默认渲染需要处理，不重复展示自动化入口', async () => {
    listSuggestionsMock.mockResolvedValueOnce([
      makeRecord({ id: 7, title: '跟进老王', reason: '三天未回复' }),
    ])
    getSuggestionStatsMock.mockResolvedValueOnce({
      ...emptyStats(),
      suggestedCount: 3,
      todayAccepted: 2,
    })
    getMemorySettingsSnapshotMock.mockResolvedValueOnce(
      makeSnapshot({
        counts: {
          active: 12,
          workspace: 5,
          global: 7,
          suspectedStale: 0,
          pinned: 0,
          daily: 0,
          runs: 0,
          pending: { conflicts: 1, stale: 0, lowConfidence: 0, total: 1 },
        },
        pending: [
          {
            id: 'p1',
            path: 'mem/p.md',
            type: 'conflict',
            status: 'open',
            created: '2026-08-01',
            statement: '候选记忆A',
            reason: '与现有记忆冲突',
            existingIds: [],
            candidate: {
              id: 'c1',
              scope: 'workspace',
              statement: '候选记忆A',
              kind: 'fact',
              confidence: 'medium',
              tags: [],
            },
            existingEntries: [],
          },
        ],
      }),
    )
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      { id: 'w1', name: 'Lume', slug: 'ws', createdAt: 1, updatedAt: 2 },
    ])
    store.set(currentWorkspaceIdAtom, 'w1')
    const env = await render({ store })
    try {
      const text = env.container.textContent ?? ''
      // header
      expect(text).toContain('记忆与洞察')
      expect(text).toMatch(/\d+ 件事需要处理/)
      // stat tiles
      expect(text).toContain('待确认')
      expect(text).toContain('待定建议')
      expect(text).toContain('长期记忆')
      expect(text).toContain('今日采纳')
      // suggestions section
      expect(text).toContain('Proma 建议')
      expect(text).toContain('跟进老王')
      expect(text).toContain('三天未回复')
      expect(text).not.toContain('正在关注')
      expect(text).not.toContain('每日回顾')
      // pending section
      expect(text).toContain('需要确认')
      expect(text).toContain('候选记忆A')
      // 三态按钮存在
      expect(uniqueKeys('accepted')).toHaveLength(1)
      expect(uniqueKeys('ignored')).toHaveLength(1)
      expect(uniqueKeys('never')).toHaveLength(1)
      // 删除按钮存在
      expect(uniqueKeys('delete')).toHaveLength(1)
      // analyze button 存在
      expect(uniqueKeys('analyze')).toHaveLength(1)
      expect(uniqueKeys('section')).toHaveLength(4)
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('空状态：各数据源为空时渲染空提示', async () => {
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      { id: 'w1', name: 'Lume', slug: 'ws', createdAt: 1, updatedAt: 2 },
    ])
    store.set(currentWorkspaceIdAtom, 'w1')
    const env = await render({ store })
    try {
      const text = env.container.textContent ?? ''
      expect(text).toContain('暂无待定建议')
      expect(text).toContain('暂无待确认记忆')
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('分析按钮 → 调 runSuggestionAnalysis + toast + 重拉', async () => {
    runSuggestionAnalysisMock.mockResolvedValueOnce({ added: 2 })
    // 首次加载 0 次，点击后重拉再 1 次
    const env = await render()
    try {
      const callsBefore = runSuggestionAnalysisMock.mock.calls.length
      const listCallsBefore = listSuggestionsMock.mock.calls.length
      const analyze = clicksFor('analyze')[0]
      expect(analyze).toBeDefined()

      await act(async () => {
        analyze!.onClick()
        await flush()
      })

      expect(runSuggestionAnalysisMock.mock.calls.length).toBeGreaterThan(
        callsBefore,
      )
      expect(toastSuccessMock).toHaveBeenCalled()
      // reload happened
      expect(listSuggestionsMock.mock.calls.length).toBeGreaterThan(
        listCallsBefore,
      )
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('建议「接受」按钮 → 调 actOnSuggestion(id,"accepted") + 重拉列表', async () => {
    listSuggestionsMock
      .mockResolvedValueOnce([makeRecord({ id: 9 })])
      .mockResolvedValueOnce([])
    const env = await render()
    try {
      const listCallsBefore = listSuggestionsMock.mock.calls.length
      const accept = clicksFor('accepted').find((c) => c.key.endsWith(':9'))
      expect(accept).toBeDefined()

      await act(async () => {
        accept!.onClick()
        await flush()
      })

      expect(actOnSuggestionMock).toHaveBeenCalledWith(9, 'accepted')
      expect(listSuggestionsMock.mock.calls.length).toBeGreaterThan(
        listCallsBefore,
      )
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('建议删除按钮 → 调 deleteSuggestion(id) + 重拉列表', async () => {
    listSuggestionsMock
      .mockResolvedValueOnce([makeRecord({ id: 5 })])
      .mockResolvedValueOnce([])
    const env = await render()
    try {
      const listCallsBefore = listSuggestionsMock.mock.calls.length
      const del = clicksFor('delete').find((c) => c.key.endsWith(':5'))
      expect(del).toBeDefined()

      await act(async () => {
        del!.onClick()
        await flush()
      })

      expect(deleteSuggestionMock).toHaveBeenCalledWith(5)
      expect(listSuggestionsMock.mock.calls.length).toBeGreaterThan(
        listCallsBefore,
      )
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('suggestionsVersionAtom 变化 → 触发重拉', async () => {
    const env = await render()
    try {
      const callsAfterMount = listSuggestionsMock.mock.calls.length
      await act(async () => {
        env.store.set(suggestionsVersionAtom, (n: number) => n + 1)
        await flush()
      })
      expect(listSuggestionsMock.mock.calls.length).toBeGreaterThan(
        callsAfterMount,
      )
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('切换到记忆区后复用唯一记忆库表面', async () => {
    const env = await render()
    try {
      const memorySection = clicksFor('section:memory')[0]
      expect(memorySection).toBeDefined()
      await act(async () => {
        memorySection!.onClick()
        await flush()
      })
      expect(env.store.get(memoryCenterDeepLinkAtom).section).toBe('memory')
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('待处理记忆可直接接受，不再跳转设置页', async () => {
    getMemorySettingsSnapshotMock.mockResolvedValueOnce(
      makeSnapshot({
        pending: [
          {
            id: 'p1',
            path: 'mem/p.md',
            type: 'conflict',
            status: 'open',
            created: '2026-08-01',
            statement: '记住我偏好深色',
            reason: '与现有「浅色」冲突',
            existingIds: [],
            candidate: {
              id: 'c1',
              scope: 'workspace',
              statement: '记住我偏好深色',
              kind: 'preference',
              confidence: 'medium',
              tags: [],
            },
            existingEntries: [],
          },
        ],
      }),
    )
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      { id: 'w1', name: 'Lume', slug: 'ws', createdAt: 1, updatedAt: 2 },
    ])
    store.set(currentWorkspaceIdAtom, 'w1')

    const env = await render({ store })
    try {
      const text = env.container.textContent ?? ''
      expect(text).toContain('记住我偏好深色')
      const accept = clicksFor('pending:accept:p1')[0]
      expect(accept).toBeDefined()
      await act(async () => {
        accept!.onClick()
        await flush()
      })
      expect(resolveMemoryPendingMock).toHaveBeenCalledWith({
        workspaceSlug: 'ws',
        path: 'mem/p.md',
        action: 'accept',
      })
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })
})
