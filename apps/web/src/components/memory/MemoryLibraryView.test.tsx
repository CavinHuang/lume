import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  MemoryReadToolResult,
  MemorySettingsEntrySummary,
  MemorySettingsPendingSummary,
} from '@lume/shared'

mock.restore()

let latestTextareaProps: React.TextareaHTMLAttributes<HTMLTextAreaElement> | null = null

mock.module('@/components/ui/button', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string
    size?: string
  }) => React.createElement('button', props, children),
}))

mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => React.createElement('input', props),
}))

mock.module('@/components/ui/textarea', () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => {
    latestTextareaProps = props
    return React.createElement('textarea', props)
  },
}))

mock.module('@/components/ui/select', () => {
  const Wrapper = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children)
  return {
    Select: Wrapper,
    SelectContent: Wrapper,
    SelectItem: Wrapper,
    SelectTrigger: Wrapper,
    SelectValue: () => null,
  }
})

mock.module('@/components/ui/switch', () => ({
  Switch: () => React.createElement('span'),
}))

const { MemoryDetailPanel, PendingMemoryCard } = await import('./MemoryLibraryView')

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
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(event: Event) {
    Object.defineProperty(event, 'target', { value: (event as Event & { target?: unknown }).target ?? this, configurable: true })
    Object.defineProperty(event, 'currentTarget', { value: this, configurable: true })
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event)
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event)
    return !event.defaultPrevented
  }
}

class FakeTextNode extends FakeEventTarget {
  readonly nodeType = 3
  nodeValue: string
  data: string

  constructor(value: string, readonly ownerDocument: FakeDocument) {
    super()
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
  readonly tagName: string
  readonly nodeName: string
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  attributes = new Map<string, string>()
  style: Record<string, string> = {}

  constructor(tagName: string, readonly ownerDocument: FakeDocument) {
    super()
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
    return this.childNodes.map((child) => 'textContent' in child ? String(child.textContent ?? '') : '').join('')
  }

  set textContent(value: string) {
    this.childNodes = []
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value))
  }
}

class FakeDocument extends FakeEventTarget {
  readonly nodeType = 9
  readonly ownerDocument = this
  readonly documentElement: FakeElement
  readonly body: FakeElement
  readonly defaultView = globalThis
  activeElement: FakeElement

  constructor() {
    super()
    this.documentElement = new FakeElement('html', this)
    this.body = new FakeElement('body', this)
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
  ] as const
  const previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>()
  for (const key of keys) previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
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
    HTMLIFrameElement: class HTMLIFrameElement extends FakeElement {},
    Text: FakeTextNode,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  })

  return {
    container: document.createElement('div'),
    cleanup: () => {
      for (const key of keys) {
        const descriptor = previousDescriptors.get(key)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function findButtonByText(node: FakeEventTarget, text: string): FakeElement | null {
  if (node instanceof FakeElement && node.tagName === 'BUTTON' && node.textContent.includes(text)) return node
  for (const child of node.childNodes) {
    const result = findButtonByText(child, text)
    if (result) return result
  }
  return null
}

const detail: MemoryReadToolResult = {
  id: 'memory-1',
  path: '/memory/memory-1.md',
  text: '已保存内容',
}

function makeEntry(overrides: Partial<MemorySettingsEntrySummary> = {}): MemorySettingsEntrySummary {
  return {
    id: 'memory-1',
    path: '/memory/memory-1.md',
    scope: 'workspace',
    kind: 'fact',
    status: 'active',
    confidence: 'medium',
    statement: '已保存内容',
    updated: '2026-08-13T00:00:00.000Z',
    pinned: false,
    tags: ['profile'],
    ...overrides,
  }
}

function makePending(overrides: Partial<MemorySettingsPendingSummary> = {}): MemorySettingsPendingSummary {
  return {
    id: 'pending-1',
    path: '/memory/pending-1.md',
    type: 'conflict',
    status: 'open',
    created: '2026-08-13T00:00:00.000Z',
    statement: '候选内容',
    reason: '与现有记忆冲突',
    existingIds: [],
    candidate: {
      scope: 'workspace',
      kind: 'fact',
      confidence: 'medium',
      statement: '候选内容',
      tags: ['candidate'],
    },
    existingEntries: [],
    ...overrides,
  }
}

function detailPanel(onUpdateEntry: React.ComponentProps<typeof MemoryDetailPanel>['onUpdateEntry']) {
  return (
    <MemoryDetailPanel
      busyAction={null}
      detail={detail}
      entry={makeEntry()}
      onDeleteEntry={() => undefined}
      onDirtyChange={() => undefined}
      onOpenFile={() => undefined}
      onUpdateEntry={onUpdateEntry}
      onToggleActivation={() => undefined}
    />
  )
}

describe('memory edit drafts', () => {
  afterAll(() => mock.restore())
  afterEach(async () => {
    latestTextareaProps = null
    await flush()
  })

  test('快照轮询返回同 ID 新对象时保留记忆编辑草稿', async () => {
    const { container, cleanup } = installFakeDom()
    const root = createRoot(container as never)
    const onUpdateEntry = mock(async () => true)
    const stableCallbacks = {
      onDeleteEntry: () => undefined,
      onDirtyChange: () => undefined,
      onOpenFile: () => undefined,
      onToggleActivation: () => undefined,
    }
    try {
      await act(async () => {
        root.render(<MemoryDetailPanel busyAction={null} detail={detail} entry={makeEntry()} onUpdateEntry={onUpdateEntry} {...stableCallbacks} />)
        await flush()
      })
      await act(async () => {
        findButtonByText(container, '编辑')!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })
      await act(async () => {
        latestTextareaProps?.onChange?.({ target: { value: '未保存草稿' } } as React.ChangeEvent<HTMLTextAreaElement>)
        await flush()
      })
      await act(async () => {
        root.render(<MemoryDetailPanel busyAction={null} detail={{ ...detail, text: '后台详情新值' }} entry={makeEntry({ updated: '2026-08-13T00:01:00.000Z' })} onUpdateEntry={onUpdateEntry} {...stableCallbacks} />)
        await flush()
      })

      expect(latestTextareaProps?.value).toBe('未保存草稿')
      expect(findButtonByText(container, '保存')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      cleanup()
    }
  })

  test('记忆保存失败时保留编辑态和草稿', async () => {
    const { container, cleanup } = installFakeDom()
    const root = createRoot(container as never)
    const onUpdateEntry = mock(async () => false)
    try {
      await act(async () => {
        root.render(detailPanel(onUpdateEntry))
        await flush()
      })
      await act(async () => {
        findButtonByText(container, '编辑')!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })
      await act(async () => {
        latestTextareaProps?.onChange?.({ target: { value: '保存失败的草稿' } } as React.ChangeEvent<HTMLTextAreaElement>)
        await flush()
      })
      await act(async () => {
        findButtonByText(container, '保存')!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(onUpdateEntry).toHaveBeenCalledTimes(1)
      expect(latestTextareaProps?.value).toBe('保存失败的草稿')
      expect(findButtonByText(container, '保存')).not.toBeNull()
      expect(findButtonByText(container, '编辑')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      cleanup()
    }
  })

  test('记忆保存成功后才退出编辑态', async () => {
    const { container, cleanup } = installFakeDom()
    const root = createRoot(container as never)
    const onUpdateEntry = mock(async () => true)
    try {
      await act(async () => {
        root.render(detailPanel(onUpdateEntry))
        await flush()
      })
      await act(async () => {
        findButtonByText(container, '编辑')!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })
      await act(async () => {
        latestTextareaProps?.onChange?.({ target: { value: '可保存草稿' } } as React.ChangeEvent<HTMLTextAreaElement>)
        await flush()
      })
      await act(async () => {
        findButtonByText(container, '保存')!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(onUpdateEntry).toHaveBeenCalledTimes(1)
      expect(findButtonByText(container, '编辑')).not.toBeNull()
      expect(findButtonByText(container, '保存')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      cleanup()
    }
  })

  test('快照轮询返回同 ID 新对象时保留手动合并草稿', async () => {
    const { container, cleanup } = installFakeDom()
    const root = createRoot(container as never)
    const onResolvePending = mock(() => undefined)
    const stableProps = {
      busyAction: null,
      onOpenFile: () => undefined,
      onResolvePending,
    }
    try {
      await act(async () => {
        root.render(<PendingMemoryCard item={makePending()} {...stableProps} />)
        await flush()
      })
      await act(async () => {
        findButtonByText(container, '手动合并')!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })
      await act(async () => {
        latestTextareaProps?.onChange?.({ target: { value: '手动合并草稿' } } as React.ChangeEvent<HTMLTextAreaElement>)
        await flush()
      })
      await act(async () => {
        root.render(<PendingMemoryCard item={makePending({ candidate: { ...makePending().candidate, statement: '后台新值' } })} {...stableProps} />)
        await flush()
      })

      expect(latestTextareaProps?.value).toBe('手动合并草稿')
      expect(findButtonByText(container, '保存并接受')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      cleanup()
    }
  })
})
