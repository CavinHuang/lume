import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LOBEHUB_SERVICES, decideIconKind } from '@/lib/provider-icon'
import { ProviderIcon } from './ProviderIcon'

// fake DOM（仿 AgentView.test.tsx / SuggestionBanner.test.tsx,仓库组件测试标准模式）。
// 用途:bun:test 无内置 DOM,需手写 fake DOM 让 createRoot 真实执行 React DOM reconciler,
//   从而把 ProviderIcon 的 lobehub 深导入链 + <Icon/> 渲染在测试期(而非运行时)暴露崩溃。
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
    return this.childNodes.map((c: FakeEventTarget) => (c as { textContent?: string }).textContent ?? '').join('')
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

function findByTag(node: FakeEventTarget, tag: string): FakeElement | undefined {
  const target = tag.toUpperCase()
  for (const child of node.childNodes) {
    if (child instanceof FakeElement && child.tagName === target) return child
    const found = findByTag(child, target)
    if (found) return found
  }
  return undefined
}

async function render(ui: React.ReactNode) {
  const env = installFakeDom()
  const root: Root | null = createRoot(env.container as never)
  await act(async () => {
    root!.render(ui)
    await flush()
  })
  return { env, root }
}

async function unmount(root: Root | null) {
  await act(async () => {
    root?.unmount()
    await flush()
  })
}

describe('ProviderIcon', () => {
  test('theSVG service: 首选社区品牌图片', async () => {
    const { env, root } = await render(<ProviderIcon service="openai" size={20} />)
    try {
      const image = findByTag(env.container, 'img')
      expect(image).toBeDefined()
      expect(image?.attributes.get('src')).toContain('thesvg')
    } finally {
      await unmount(root)
      env.cleanup()
    }
  })

  // Lobe 模块仍会在 ProviderIcon 模块加载时完成深导入；这里同时守卫社区首选与本地回退判定。
  test.each(LOBEHUB_SERVICES)(
    'lobehub service[%s]: 首选 theSVG，失败时仍判定为本地 lobehub',
    async (service) => {
      const { env, root } = await render(<ProviderIcon service={service} size={20} />)
      try {
        expect(findByTag(env.container, 'img')).toBeDefined()
        expect(decideIconKind(service, true)).toBe('lobehub')
      } finally {
        await unmount(root)
        env.cleanup()
      }
    },
  )

  test('通用 SaaS service: 优先渲染 theSVG 品牌图标', async () => {
    const { env, root } = await render(<ProviderIcon service="stripe" size={20} />)
    try {
      const image = findByTag(env.container, 'img')
      expect(image).toBeDefined()
      expect(image?.attributes.get('src')).toContain('/stripe/default.svg')
    } finally {
      await unmount(root)
      env.cleanup()
    }
  })

  test('theSVG 未覆盖的 service: 使用本地 OOMOL 品牌图标', async () => {
    const { env, root } = await render(<ProviderIcon service="17track" displayName="17TRACK" size={20} />)
    try {
      const image = findByTag(env.container, 'img')
      expect(image).toBeDefined()
      expect(image?.attributes.get('src')).toBe('/provider-logos/17track.svg')
    } finally {
      await unmount(root)
      env.cleanup()
    }
  })

  test('非 lobehub service: 走首字母分支,产出含首字母的彩色块 DOM', async () => {
    const { env, root } = await render(<ProviderIcon service="some_custom_app" />)
    try {
      // some_custom_app 不在 LOBEHUB_SERVICES/LINK_ICONS 且无 iconUrl → decideIconKind 返回 "letter"
      // → LetterBlock 渲染 initialOf("some_custom_app") = "S"
      expect(env.container.textContent).toBe('S')
      const block = findByTag(env.container, 'div')
      expect(block).toBeDefined()
      // colorForSeed 已执行,内联 background 写入 style
      expect(block!.style.background).toBeTruthy()
    } finally {
      await unmount(root)
      env.cleanup()
    }
  })
})
