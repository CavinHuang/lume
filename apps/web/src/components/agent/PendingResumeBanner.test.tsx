import { beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentGetPendingResumeResult, AgentResumeRunResult } from '@lume/shared'

mock.restore()

// ── desktop-api mock：getAgentPendingResume / resumeAgentRun ────────────────
const getPendingResumeMock = mock(async () => ({ threadId: 't', hasPendingResume: false }) as AgentGetPendingResumeResult)
const resumeRunMock = mock(async () => ({ status: 'resumed' } as AgentResumeRunResult))

mock.module('@/lib/desktop-api', () => ({
  getAgentPendingResume: (threadId: string) => getPendingResumeMock(threadId),
  resumeAgentRun: (input: { threadId: string; runId?: string }) => resumeRunMock(input),
}))

// ── Button mock：捕获 onClick，绕过 fake DOM 不派发 React 合成事件 ────────
// （仿 SuggestionBanner.test.tsx 用 props 捕获子组件回调的模式）
type CapturedButton = {
  action?: string
  title?: string
  onClick?: () => void
  label: string
}
const capturedButtons: CapturedButton[] = []

mock.module('@/components/ui/button', () => ({
  Button: (props: {
    children?: React.ReactNode
    onClick?: () => void
    'data-pending-resume-action'?: string
    title?: string
  }) => {
    capturedButtons.push({
      action: props['data-pending-resume-action'],
      title: props.title,
      onClick: props.onClick,
      label: textOf(props.children),
    })
    const children = Array.isArray(props.children) ? props.children : [props.children]
    return React.createElement(
      'button',
      {
        type: 'button',
        'data-pending-resume-action': props['data-pending-resume-action'],
        title: props.title,
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

// ── fake DOM（仿 AgentView.test.tsx / SuggestionBanner.test.tsx 标准模式）──
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

const { PendingResumeBanner } = await import('./PendingResumeBanner')

async function render(threadId: string) {
  const env = installFakeDom()
  const root: Root | null = createRoot(env.container as never)
  await act(async () => {
    root!.render(<PendingResumeBanner threadId={threadId} />)
    await flush()
  })
  return { ...env, root }
}

async function unmount(env: { root: Root | null }) {
  await act(async () => {
    env.root?.unmount()
    env.root = null
    await flush()
  })
}

describe('PendingResumeBanner', () => {
  beforeEach(() => {
    getPendingResumeMock.mockReset()
    resumeRunMock.mockReset()
    getPendingResumeMock.mockResolvedValue({ threadId: 't', hasPendingResume: false })
    resumeRunMock.mockResolvedValue({ status: 'resumed' })
    capturedButtons.length = 0
  })

  test('无待恢复 run 时不渲染任何内容', async () => {
    getPendingResumeMock.mockResolvedValueOnce({ threadId: 't-free', hasPendingResume: false })
    const env = await render('t-free')
    try {
      expect(env.container.childNodes.length).toBe(0)
      expect(env.container.textContent).toBe('')
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('有待恢复 run 时渲染提示 + 继续/放弃按钮', async () => {
    getPendingResumeMock.mockResolvedValueOnce({
      threadId: 't-pending', hasPendingResume: true, runId: 'run-1',
    })
    const env = await render('t-pending')
    try {
      const text = env.container.textContent ?? ''
      expect(text).toContain('上次有未完成任务，是否继续？')
      const actions = Array.from(new Set(capturedButtons.map((b) => b.action)))
      expect(actions).toContain('resume')
      expect(actions).toContain('discard')
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('点继续 → resumeAgentRun({threadId, runId}) 被调 + 横幅消失', async () => {
    getPendingResumeMock.mockResolvedValueOnce({
      threadId: 't-resume', hasPendingResume: true, runId: 'run-2',
    })
    const env = await render('t-resume')
    try {
      const resumeBtn = capturedButtons.find((b) => b.action === 'resume')
      expect(resumeBtn).toBeDefined()
      await act(async () => {
        resumeBtn!.onClick!()
        await flush()
      })
      expect(resumeRunMock).toHaveBeenCalledWith({ threadId: 't-resume', runId: 'run-2' })
      expect(env.container.childNodes.length).toBe(0)
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('resume 返回 not_resumable → 友好文案而非报错', async () => {
    getPendingResumeMock.mockResolvedValueOnce({
      threadId: 't-notres', hasPendingResume: true, runId: 'run-3',
    })
    resumeRunMock.mockResolvedValueOnce({ status: 'not_resumable', error: '找不到 run state。' })
    const env = await render('t-notres')
    try {
      const resumeBtn = capturedButtons.find((b) => b.action === 'resume')
      await act(async () => {
        resumeBtn!.onClick!()
        await flush()
      })
      const text = env.container.textContent ?? ''
      expect(text).toContain('该任务无法自动恢复')
      expect(text).not.toContain('not_resumable')
      expect(text).not.toContain('找不到 run state')
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('threadId 原地切换：A 有横幅 → 切到无 pending 的 B → 横幅消失', async () => {
    getPendingResumeMock.mockImplementation(async (threadId: string) =>
      threadId === 't-switch-a'
        ? { threadId, hasPendingResume: true, runId: 'run-a' }
        : { threadId, hasPendingResume: false })
    const env = await render('t-switch-a')
    try {
      expect(env.container.textContent ?? '').toContain('上次有未完成任务')
      // AgentView 切线程不重挂组件，threadId 原地变化
      await act(async () => {
        env.root!.render(<PendingResumeBanner threadId="t-switch-b" />)
        await flush()
      })
      expect(env.container.childNodes.length).toBe(0)
      expect(env.container.textContent).toBe('')
      // 不会以 B 的 threadId + A 的 runId 调 resume
      expect(resumeRunMock).not.toHaveBeenCalled()
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('resume in-flight 期间重复点继续只发一次 resume-run', async () => {
    getPendingResumeMock.mockResolvedValueOnce({
      threadId: 't-dbl', hasPendingResume: true, runId: 'run-dbl',
    })
    let resolveResume!: (v: AgentResumeRunResult) => void
    resumeRunMock.mockImplementationOnce(() => new Promise((r) => { resolveResume = r }))
    const env = await render('t-dbl')
    try {
      const resumeBtn = capturedButtons.filter((b) => b.action === 'resume').at(-1)
      expect(resumeBtn).toBeDefined()
      await act(async () => {
        resumeBtn!.onClick!()
        resumeBtn!.onClick!() // in-flight 期间重复点击
        await flush()
      })
      expect(resumeRunMock.mock.calls.length).toBe(1)
      await act(async () => {
        resolveResume({ status: 'resumed' })
        await flush()
      })
      expect(env.container.childNodes.length).toBe(0)
    } finally {
      await unmount(env)
      env.cleanup()
    }
  })

  test('点放弃 → 横幅消失且本周期内重开不再提示、不调 resume', async () => {
    getPendingResumeMock.mockResolvedValue({
      threadId: 't-discard', hasPendingResume: true, runId: 'run-4',
    })
    const env = await render('t-discard')
    try {
      const discardBtn = capturedButtons.find((b) => b.action === 'discard')
      expect(discardBtn).toBeDefined()
      await act(async () => {
        discardBtn!.onClick!()
        await flush()
      })
      expect(resumeRunMock).not.toHaveBeenCalled()
      expect(env.container.childNodes.length).toBe(0)
    } finally {
      await unmount(env)
      env.cleanup()
    }

    // 重挂载（同周期内重开线程）不再提示
    const env2 = await render('t-discard')
    try {
      expect(env2.container.childNodes.length).toBe(0)
    } finally {
      await unmount(env2)
      env2.cleanup()
    }
  })
})
