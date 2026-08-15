import { beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SdkEventEnvelope } from '@lume/shared'

mock.restore()

// ── desktop-api/agent mock ─────────────────────────────────────────────────
const getAgentEventsMock = mock(async () => ({ threadId: '', events: [] as SdkEventEnvelope[] }))
const unlistenMock = mock(() => {})
let pushHandler: ((e: SdkEventEnvelope) => void) | null = null
const onAgentEventsMock = mock((cb: (e: SdkEventEnvelope) => void) => {
  pushHandler = cb
  return Promise.resolve(unlistenMock)
})

mock.module('@/lib/desktop-api/agent', () => ({
  getAgentEvents: (...args: unknown[]) =>
    getAgentEventsMock(...(args as [string, (number | undefined)?])),
  onAgentEvents: (...args: unknown[]) =>
    onAgentEventsMock(...(args as [(e: SdkEventEnvelope) => void])),
}))

// ── fake DOM（仿 SuggestionBanner.test.tsx，仅保留 createRoot 最小集合）────
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
  nodeValue: string
  constructor(value: string) {
    super()
    this.nodeValue = value
  }
  get textContent() {
    return this.nodeValue
  }
}

class FakeElement extends FakeEventTarget {
  readonly nodeType = 1 as const
  tagName: string
  nodeName: string
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  attributes = new Map<string, string>()
  style: Record<string, string> = {}
  ownerDocument: FakeDocument
  constructor(tagName: string, ownerDocument: FakeDocument) {
    super()
    this.tagName = tagName.toUpperCase()
    this.nodeName = this.tagName
    this.ownerDocument = ownerDocument
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  removeAttribute(name: string) {
    this.attributes.delete(name)
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

class FakeIFrameElement extends FakeElement {}

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
  createTextNode(value: string) {
    return new FakeTextNode(value)
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
  ] as const
  const previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>()
  for (const key of keys) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  const document = new FakeDocument()
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document,
    window: globalThis,
    self: globalThis,
    navigator: { userAgent: 'bun' },
    Node: FakeEventTarget,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: FakeIFrameElement,
    Text: FakeTextNode,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
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

const { useAgentEventBus } = await import('./useAgentEventBus')

function envelope(threadId: string, seq: number): SdkEventEnvelope {
  return {
    v: 1,
    seq,
    threadId,
    runId: 'run-1',
    turnId: null,
    ts: seq,
    kind: 'run',
    phase: 'event',
    detail: { type: 'run.start' },
  }
}

function Harness(props: { threadId: string; enabled: boolean; onEvent: (e: SdkEventEnvelope) => void }) {
  useAgentEventBus(props.threadId, { enabled: props.enabled, onEvent: props.onEvent })
  return null
}

async function mount() {
  const env = installFakeDom()
  const received: SdkEventEnvelope[] = []
  const root: Root = createRoot(env.container as never)
  const rerender = async (threadId: string) => {
    await act(async () => {
      root.render(<Harness threadId={threadId} enabled onEvent={(e) => received.push(e)} />)
      await flush()
    })
  }
  const unmount = async () => {
    await act(async () => {
      root.unmount()
      await flush()
    })
  }
  return { ...env, received, rerender, unmount }
}

function scriptPull(...responses: Array<SdkEventEnvelope[]>) {
  const queue = [...responses]
  getAgentEventsMock.mockImplementation(async () => ({
    threadId: '',
    events: queue.shift() ?? [],
  }))
}

function push(e: SdkEventEnvelope) {
  pushHandler?.(e)
}

describe('useAgentEventBus', () => {
  beforeEach(() => {
    getAgentEventsMock.mockReset()
    scriptPull()
    onAgentEventsMock.mockReset()
    onAgentEventsMock.mockImplementation((cb: (e: SdkEventEnvelope) => void) => {
      pushHandler = cb
      return Promise.resolve(unlistenMock)
    })
    unlistenMock.mockReset()
    pushHandler = null
  })

  test('首次挂载无 afterSeq 全量拉取，回调按 seq 有序', async () => {
    scriptPull([envelope('t1', 2), envelope('t1', 1), envelope('t1', 3)])
    const t = await mount()
    await t.rerender('t1')
    expect(getAgentEventsMock.mock.calls[0]).toEqual(['t1', undefined])
    expect(t.received.map((e) => e.seq)).toEqual([1, 2, 3])
    await t.unmount()
    t.cleanup()
  })

  test('线程切回重挂时带 afterSeq 续传（最大 seq=5）', async () => {
    scriptPull(
      [envelope('t1', 1), envelope('t1', 2), envelope('t1', 3), envelope('t1', 4), envelope('t1', 5)],
      [],
      [envelope('t1', 6)],
    )
    const t = await mount()
    await t.rerender('t1')
    await t.rerender('t2')
    await t.rerender('t1')
    const callsForT1 = getAgentEventsMock.mock.calls.filter((c) => c[0] === 't1')
    expect(callsForT1).toHaveLength(2)
    expect(callsForT1[1]).toEqual(['t1', 5])
    await t.unmount()
    t.cleanup()
  })

  test('push 与 pull 交叠去重：只收到 1,2,3 各一次且有序', async () => {
    scriptPull([envelope('t1', 1), envelope('t1', 2)])
    const t = await mount()
    await t.rerender('t1')
    push(envelope('t1', 1))
    push(envelope('t1', 2))
    push(envelope('t1', 3))
    await act(async () => { await flush() })
    expect(t.received.map((e) => e.seq)).toEqual([1, 2, 3])
    await t.unmount()
    t.cleanup()
  })

  test('push 出现空洞（seq 5 > 本地最大 3+1）触发无 afterSeq 全量重拉并归并', async () => {
    scriptPull(
      [envelope('t1', 1), envelope('t1', 2), envelope('t1', 3)],
      [envelope('t1', 1), envelope('t1', 2), envelope('t1', 3), envelope('t1', 4), envelope('t1', 5)],
    )
    const t = await mount()
    await t.rerender('t1')
    push(envelope('t1', 5))
    await act(async () => { await flush() })
    expect(getAgentEventsMock.mock.calls).toHaveLength(2)
    expect(getAgentEventsMock.mock.calls[1]).toEqual(['t1'])
    expect(t.received.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    await t.unmount()
    t.cleanup()
  })

  test('threadId 切换：退订旧线程推送，事件不再进入回调', async () => {
    scriptPull([envelope('t1', 1)], [envelope('t2', 1), envelope('t2', 2)])
    const t = await mount()
    await t.rerender('t1')
    expect(t.received.map((e) => e.seq)).toEqual([1])
    await t.rerender('t2')
    expect(unlistenMock).toHaveBeenCalled()
    push(envelope('t1', 2))
    push(envelope('t2', 3))
    await act(async () => { await flush() })
    expect(t.received.filter((e) => e.threadId === 't1').map((e) => e.seq)).toEqual([1])
    expect(t.received.filter((e) => e.threadId === 't2').map((e) => e.seq)).toEqual([1, 2, 3])
    await t.unmount()
    t.cleanup()
  })
})
