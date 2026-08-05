import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MemorySettingsEntrySummary } from '@lume/shared'

mock.restore()

// Switch 由 base-ui 实现，fake DOM 下点击链路不稳定；改 stub 为简单 button，
// 点击 → onCheckedChange(!checked)，便于断言 ActivationToggleGroup 行为。
mock.module('@/components/ui/switch', () => {
  const Switch = ({
    checked,
    disabled,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: {
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (value: boolean) => void
    'aria-label'?: string
  }) => {
    return React.createElement(
      'button',
      {
        type: 'button',
        'data-slot': 'switch',
        'data-checked': checked ? 'true' : 'false',
        'aria-label': ariaLabel,
        disabled: disabled ?? false,
        onClick: () => onCheckedChange?.(!checked),
      },
      String(checked ? 'on' : 'off'),
    )
  }
  return { Switch }
})

const { ActivationToggleGroup } = await import('./MemorySettings')

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

function findSwitchByLabel(node: FakeEventTarget, label: string): FakeElement | null {
  if (node instanceof FakeElement && node.tagName === 'BUTTON' && node.attributes.get('aria-label') === `激活用途：${label}`) {
    return node
  }
  for (const child of node.childNodes) {
    const result = findSwitchByLabel(child, label)
    if (result) return result
  }
  return null
}

function makeEntry(activation: MemorySettingsEntrySummary['activation']): MemorySettingsEntrySummary {
  return {
    id: 'mem-1',
    path: '/tmp/mem-1.md',
    scope: 'workspace',
    kind: 'preference',
    status: 'active',
    confidence: 'medium',
    statement: '叫我 Mason',
    updated: '2026-08-05T00:00:00.000Z',
    pinned: false,
    tags: ['profile'],
    ...(activation ? { activation } : {}),
  }
}

describe('ActivationToggleGroup', () => {
  afterAll(() => {
    mock.restore()
  })

  afterEach(async () => {
    await flush()
  })

  test('legacy entry (no activation): defaults to all-true; renders 4 toggles', async () => {
    const onToggle = mock((_activation: any) => undefined)
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <ActivationToggleGroup
            entry={makeEntry(undefined)}
            disabled={false}
            onToggle={onToggle}
          />,
        )
        await flush()
      })

      // 4 标签均渲染
      expect(container.textContent).toContain('激活用途')
      expect(container.textContent).toContain('召回')
      expect(container.textContent).toContain('Persona')
      expect(container.textContent).toContain('主动建议')
      expect(container.textContent).toContain('工作模式分析')

      // 默认全 true：每个 switch data-checked='true'
      for (const label of ['召回', 'Persona', '主动建议', '工作模式分析']) {
        const sw = findSwitchByLabel(container, label)!
        expect(sw).not.toBeNull()
        expect(sw.attributes.get('data-checked')).toBe('true')
      }
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('partial activation: reflects per-purpose state', async () => {
    const onToggle = mock((_activation: any) => undefined)
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <ActivationToggleGroup
            entry={makeEntry({ recall: true, persona: false, suggestion: true, analyst: false })}
            disabled={false}
            onToggle={onToggle}
          />,
        )
        await flush()
      })

      expect(findSwitchByLabel(container, '召回')!.attributes.get('data-checked')).toBe('true')
      expect(findSwitchByLabel(container, 'Persona')!.attributes.get('data-checked')).toBe('false')
      expect(findSwitchByLabel(container, '主动建议')!.attributes.get('data-checked')).toBe('true')
      expect(findSwitchByLabel(container, '工作模式分析')!.attributes.get('data-checked')).toBe('false')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('click switch → onToggle receives new activation object with toggled key', async () => {
    const onToggle = mock((_activation: any) => undefined)
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <ActivationToggleGroup
            entry={makeEntry({ recall: true, persona: true, suggestion: false, analyst: true })}
            disabled={false}
            onToggle={onToggle}
          />,
        )
        await flush()
      })

      // 点击「主动建议」(false → true)
      const suggestionSwitch = findSwitchByLabel(container, '主动建议')!
      await act(async () => {
        suggestionSwitch.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(onToggle).toHaveBeenCalledTimes(1)
      expect(onToggle).toHaveBeenCalledWith({
        recall: true,
        persona: true,
        suggestion: true,
        analyst: true,
      })
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('disabled prop: switches render disabled', async () => {
    const onToggle = mock((_activation: any) => undefined)
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <ActivationToggleGroup
            entry={makeEntry(undefined)}
            disabled={true}
            onToggle={onToggle}
          />,
        )
        await flush()
      })

      const recallSwitch = findSwitchByLabel(container, '召回')!
      expect(recallSwitch.attributes.get('disabled')).toBeDefined()
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
