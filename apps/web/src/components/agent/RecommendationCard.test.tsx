import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RecommendationOption } from './RecommendationCard'

mock.restore()

// ── Button mock：捕获 onClick，绕过 fake DOM 不派发 React 合成事件 ────────
// 仿 SuggestionBanner.test.tsx 的捕获模式。
type CapturedButton = { label: string; onClick?: () => void; ariaExpanded?: boolean }
let capturedButtons: CapturedButton[] = []

mock.module('@/components/ui/button', () => ({
  Button: (props: { children?: React.ReactNode; onClick?: () => void; 'aria-expanded'?: boolean }) => {
    capturedButtons.push({
      label: textOf(props.children),
      onClick: props.onClick,
      ariaExpanded: props['aria-expanded'],
    })
    return React.createElement('button', { type: 'button' }, props.children)
  },
}))

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return ''
}

// ── fake DOM（仿 MemoryActivationToggle.test.tsx）─────────────────────────
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
    this.listeners.set(type, set.add(listener))
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

const OPTIONS: RecommendationOption[] = [
  { key: 'high', body: '从 cone_king 补货，交期 7 天。', short: 'cone_king · 7 天交期', signal: 3, cta: '接受' },
  { key: 'review', body: '香草换为 vanilla_madagascar。', short: '换 vanilla_madagascar', signal: 2 },
  { key: 'none', body: '全量补货所有 SKU。', short: '全量补货', signal: 0 },
]

const { RecommendationCard } = await import('./RecommendationCard')

describe('RecommendationCard', () => {
  afterAll(() => {
    mock.restore()
  })

  afterEach(async () => {
    await flush()
    capturedButtons = []
  })

  test('renders title, active option and alternatives drawer rows', async () => {
    const onAccept = mock(() => undefined)
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <RecommendationCard title="要我下这个补货单吗？" options={OPTIONS} onAccept={onAccept} />,
        )
        await flush()
      })

      const text = container.textContent
      expect(text).toContain('要我下这个补货单吗？')
      expect(text).toContain('从 cone_king 补货，交期 7 天。')
      // 备选行存在（抽屉收起但内容在 DOM）
      expect(text).toContain('换 vanilla_madagascar')
      expect(text).toContain('全量补货')
      // 置信标签按 signal 推断
      expect(text).toContain('高置信')
      expect(text).toContain('需确认')
      expect(text).toContain('无信号')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('accept invokes onAccept with the active option', async () => {
    const onAccept = mock(() => undefined)
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <RecommendationCard title="确认补货？" options={OPTIONS} onAccept={onAccept} />,
        )
        await flush()
      })

      const accept = capturedButtons.find((button) => button.label === '接受')
      expect(accept?.onClick).toBeInstanceOf(Function)

      await act(async () => {
        accept!.onClick!()
        await flush()
      })
      expect(onAccept).toHaveBeenCalledTimes(1)
      expect(onAccept).toHaveBeenCalledWith(OPTIONS[0])
      // 接受后按钮进入已接受态
      expect(container.textContent).toContain('已接受')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('toggling alternatives opens the drawer (aria-expanded flips)', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <RecommendationCard title="确认补货？" options={OPTIONS} />,
        )
        await flush()
      })

      const toggle = capturedButtons.find((button) => button.label === '备选')
      expect(toggle?.ariaExpanded).toBe(false)

      await act(async () => {
        toggle!.onClick!()
        await flush()
      })
      const openToggle = [...capturedButtons].reverse().find((button) => button.label === '备选')
      expect(openToggle?.ariaExpanded).toBe(true)
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('defaultSelectedKey selects a non-first option', async () => {
    const onAccept = mock(() => undefined)
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <RecommendationCard
            title="确认补货？"
            options={OPTIONS}
            defaultSelectedKey="none"
            onAccept={onAccept}
          />,
        )
        await flush()
      })

      expect(container.textContent).toContain('全量补货所有 SKU。')

      const accept = capturedButtons.find((button) => button.label === '接受')
      await act(async () => {
        accept!.onClick!()
        await flush()
      })
      expect(onAccept).toHaveBeenCalledWith(OPTIONS[2])
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('prevents duplicate accepts while an async action is pending', async () => {
    let resolveAccept: (() => void) | undefined
    const onAccept = mock(() => new Promise<void>((resolve) => {
      resolveAccept = resolve
    }))
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<RecommendationCard title="确认补货？" options={OPTIONS} onAccept={onAccept} />)
        await flush()
      })

      const accept = capturedButtons.find((button) => button.label === '接受')
      await act(async () => {
        accept!.onClick!()
        accept!.onClick!()
        await flush()
      })
      expect(onAccept).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('处理中…')

      await act(async () => {
        resolveAccept?.()
        await flush()
      })
      expect(container.textContent).toContain('已接受')
    } finally {
      await act(async () => {
        resolveAccept?.()
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('falls back to the first option when refreshed options remove the selection', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<RecommendationCard title="确认补货？" options={OPTIONS} defaultSelectedKey="none" />)
        await flush()
      })
      expect(container.textContent).toContain('全量补货所有 SKU。')

      await act(async () => {
        root!.render(<RecommendationCard title="确认补货？" options={OPTIONS.slice(0, 2)} defaultSelectedKey="none" />)
        await flush()
      })
      expect(container.textContent).toContain('从 cone_king 补货，交期 7 天。')
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
