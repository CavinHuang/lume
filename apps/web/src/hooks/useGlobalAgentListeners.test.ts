import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { AGENT_IPC_CHANNELS, type LumeRuntimeEvent, type SubagentRunRecord } from '@lume/shared'
import { agentRuntimeEventsAtom } from '@/atoms'

// 真实定时器引用必须在任何全局替换之前捕获(sleep 辅助用)
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms))

mock.restore()

// ===== mocks（必须先于动态 import 注册；bun:test 的 mock.module 进程级共享，
// 按 QuickInput.test.tsx 的既有约定处理）=====
let sidecarHandler: ((method: string, params: unknown) => void) | null = null

await mock.module('@/lib/desktop-api', () => ({
  acknowledgeRendererDelivery: async () => ({ ok: true }),
  onSidecarEvent: (cb: (method: string, params: unknown) => void) => {
    sidecarHandler = cb
    return Promise.resolve(() => {})
  },
  onSuggestionsChanged: (_cb: () => void) => Promise.resolve(() => {}),
  sidecarCall: async (method: string) => {
    if (method === AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE) return []
    if (method === AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS) return { runs: [] }
    if (method === AGENT_IPC_CHANNELS.LIST_THREADS) return []
    return {}
  },
}))
await mock.module('@/lib/desktop-api/agent', () => ({
  getAgentEvents: async () => ({ threadId: '', events: [] }),
  onAgentEvents: (_cb: (e: unknown) => void) => Promise.resolve(() => {}),
}))

const listenerModule = await import('./useGlobalAgentListeners')
const { RUNTIME_EVENT_FALLBACK_FLUSH_MS } = listenerModule

function createRun(runId: string, parentThreadId: string): SubagentRunRecord {
  return {
    runId,
    parentThreadId,
    rootThreadId: parentThreadId,
    depth: 1,
    childThreadId: `child-${runId}`,
    task: runId,
    status: 'completed',
    cleanup: 'keep',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('useGlobalAgentListeners subagent run hydration', () => {
  test('冷启动时按父会话分组持久化的 subagent runs', () => {
    const hydrate = (listenerModule as {
      hydrateSubagentRuns?: (
        current: Record<string, SubagentRunRecord[]>,
        runs: SubagentRunRecord[],
      ) => Record<string, SubagentRunRecord[]>
    }).hydrateSubagentRuns
    expect(hydrate).toBeFunction()

    const result = hydrate!({}, [
      createRun('run-a1', 'parent-a'),
      createRun('run-b1', 'parent-b'),
      createRun('run-a2', 'parent-a'),
    ])

    expect(result['parent-a']?.map((run) => run.runId)).toEqual(['run-a1', 'run-a2'])
    expect(result['parent-b']?.map((run) => run.runId)).toEqual(['run-b1'])
  })
})

// ===== #676 双调度冲刷测试：fake DOM + 受控 rAF + 转发型定时器包装 =====
// rAF 完全手动驱动（模拟后台暂停时不产帧）；setTimeout/clearTimeout 只包装记录、
// 仍转发真实实现，避免破坏 React/bun 内部对真实定时器的依赖。

class FakeEventTarget {
  parentNode: FakeEventTarget | null = null
  childNodes: FakeEventTarget[] = []
  protected listeners = new Map<string, Set<(e: unknown) => void>>()

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
    if (i >= 0) this.childNodes.splice(i, 1)
    node.parentNode = null
    return node
  }
  contains(target: unknown) {
    if (target === this) return true
    return this.childNodes.some((c) => c.contains(target))
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
  focus() {}
  get textContent() {
    return this.childNodes.map((c) => c.textContent ?? '').join('')
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
  constructor() {
    super()
    this.documentElement = new FakeElement('html', this)
    this.body = new FakeElement('body', this)
    this.defaultView = globalThis
    this.appendChild(this.documentElement)
    this.documentElement.appendChild(this.body)
  }
  createElement(tagName: string) {
    return new FakeElement(tagName, this)
  }
  createTextNode(value: string) {
    return new FakeTextNode(value, this)
  }
}

interface SchedulerStub {
  rafQueue: Map<number, FrameRequestCallback>
  rafCancelled: number[]
  runNextFrame(): boolean
}

function installSchedulerDom(): { container: FakeElement; cleanup: () => void; sched: SchedulerStub } {
  const rafQueue = new Map<number, FrameRequestCallback>()
  const rafCancelled: number[] = []
  let nextHandle = 1

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
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      const id = nextHandle++
      rafQueue.set(id, cb)
      return id
    },
    cancelAnimationFrame: (handle: number) => {
      rafCancelled.push(handle)
      rafQueue.delete(handle)
    },
  }
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
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
    sched: {
      rafQueue,
      rafCancelled,
      runNextFrame(): boolean {
        const entry = rafQueue.entries().next()
        if (entry.done) return false
        const [id, cb] = entry.value
        rafQueue.delete(id)
        cb(0)
        return true
      },
    },
  }
}

async function flushMicro() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const THREAD_ID = 't-676'

function makeEvent(id: string, createdAtMs: number): LumeRuntimeEvent {
  return {
    id,
    type: 'run.started',
    threadId: THREAD_ID,
    runId: `run-${id}`,
    createdAt: new Date(Date.UTC(2026, 7, 25, 0, 0, 0) + createdAtMs * 1000).toISOString(),
  }
}

describe('useGlobalAgentListeners 运行时事件双调度冲刷(#676)', () => {
  let env: ReturnType<typeof installSchedulerDom>
  let rootRef: { current: Root | null }

  beforeEach(() => {
    sidecarHandler = null
    env = installSchedulerDom()
    rootRef = { current: null }
  })

  afterEach(async () => {
    await act(async () => {
      rootRef.current?.unmount()
      rootRef.current = null
      await flushMicro()
    })
    env.cleanup()
  })

  async function mount() {
    const store = createStore()
    await act(async () => {
      const root = createRoot(env.container as never)
      rootRef.current = root
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(function Probe() {
            listenerModule.useGlobalAgentListeners()
            return React.createElement('div')
          }),
        ),
      )
      await flushMicro()
    })
    expect(sidecarHandler).toBeFunction()
    return store
  }

  function inject(event: LumeRuntimeEvent) {
    sidecarHandler!(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: event.threadId, event })
  }

  function eventsOf(store: ReturnType<typeof createStore>) {
    return store.get(agentRuntimeEventsAtom)[THREAD_ID]?.events ?? []
  }

  test('前台：rAF 先行冲刷，atom 恰写入一次且兜底不产生第二次写', async () => {
    const store = await mount()
    inject(makeEvent('e1', 1))

    expect(env.sched.rafQueue.size).toBe(1)

    expect(env.sched.runNextFrame()).toBe(true)
    expect(eventsOf(store).map((event) => event.id)).toEqual(['e1'])

    // 行为级互斥验证：越过兜底时限后无重复提交（定时器已被冲刷吊销）
    await sleep(RUNTIME_EVENT_FALLBACK_FLUSH_MS + 250)
    expect(eventsOf(store)).toHaveLength(1)
  })

  test('后台：rAF 悬挂时兜底定时器在时限内提交，rAF 被吊销且迟到帧零写入', async () => {
    const store = await mount()
    inject(makeEvent('e2', 2))

    // 模拟后台暂停：不产帧，rAF 保持悬挂
    expect(env.sched.rafQueue.size).toBe(1)
    await sleep(RUNTIME_EVENT_FALLBACK_FLUSH_MS + 250)

    expect(eventsOf(store).map((event) => event.id)).toEqual(['e2'])
    expect(env.sched.rafCancelled.length).toBe(1)
    expect(env.sched.runNextFrame()).toBe(false)
    expect(eventsOf(store)).toHaveLength(1)
  })

  test('同批多事件单帧合并提交，冲刷窗口内只调度一个 rAF', async () => {
    const store = await mount()
    inject(makeEvent('e3a', 1))
    inject(makeEvent('e3b', 2))

    expect(env.sched.rafQueue.size).toBe(1)
    expect(env.sched.runNextFrame()).toBe(true)
    expect(eventsOf(store).map((event) => event.id)).toEqual(['e3a', 'e3b'])
    expect(env.sched.runNextFrame()).toBe(false)
  })

  test('cleanup：卸载取消双句柄、残留恰同步冲刷一次，陈旧回调零写入', async () => {
    const store = await mount()
    inject(makeEvent('e4', 4))

    await act(async () => {
      rootRef.current?.unmount()
      rootRef.current = null
      await flushMicro()
    })

    expect(env.sched.rafCancelled.length).toBe(1)
    const events = eventsOf(store)
    expect(events.map((event) => event.id)).toEqual(['e4'])

    // 陈旧回调零写入：等待原时限过后内容与引用均不变（双句柄均已取消）
    await sleep(RUNTIME_EVENT_FALLBACK_FLUSH_MS + 250)
    expect(env.sched.runNextFrame()).toBe(false)
    expect(store.get(agentRuntimeEventsAtom)[THREAD_ID]?.events).toBe(events)
  })
})
