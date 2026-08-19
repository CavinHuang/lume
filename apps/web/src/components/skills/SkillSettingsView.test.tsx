import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { getDefaultStore } from 'jotai'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

mock.restore()

const defaultEditableSkills = () => [
  {
    slug: 'skill-creator',
    name: 'Skill 生成器',
    storageScope: 'workspace' as const,
    managementSurface: 'settings' as const,
    description: '帮助用户创建 Skill',
    allowedTools: ['bash'],
  },
  {
    slug: 'market-review',
    name: 'Market Review',
    storageScope: 'workspace' as const,
    managementSurface: 'market' as const,
    sourceType: 'built-in' as const,
    description: 'Installed from skill market',
  },
]

const listEditableSkillsMock = mock(async () => defaultEditableSkills())

const getEditableSkillMock = mock(async () => ({
  skill: {
    slug: 'skill-creator',
    name: 'Skill 生成器',
    storageScope: 'workspace' as const,
    description: '帮助用户创建 Skill',
    allowedTools: ['bash'],
  },
  content: '---\nname: Skill 生成器\n---\n\nPrompt body.',
}))

const getEffectiveLumeConfigMock = mock(async () => ({
  version: 1 as const,
  sourcePath: '/tmp/lume.yaml',
  permissions: {
    toolPolicy: { allow: [], deny: [] },
  },
}))

const getSkillMarketCatalogMock = mock(async () => ({
  items: [],
  diagnostics: [],
}))

const listSkillVersionsMock = mock(async () => [
  { path: '/tmp/versions/SKILL_20260605_010203_abcd.md', filename: 'SKILL_20260605_010203_abcd.md', timestamp: '20260605 010203' },
])

const analyzeSkillImprovementMock = mock(async () => ({
  skillSlug: 'skill-creator',
  usageCount: 1,
  analyzedSessionIds: ['thread-1'],
  updates: [
    { section: '触发条件', change: '收窄到创建或优化 skill 的请求', reason: '最近对话里有误触发' },
  ],
}))

;(globalThis as any).__lumeDesktopApiMocks = {
  analyzeSkillImprovement: analyzeSkillImprovementMock,
  deleteWorkspaceSkill: mock(async () => ({ ok: true })),
  getEditableSkill: getEditableSkillMock,
  getSkillMarketCatalog: getSkillMarketCatalogMock,
  getMcpConfig: mock(async () => ({ servers: {} })),
  getMcpStatus: mock(async () => ({ servers: {} })),
  listSkillVersions: listSkillVersionsMock,
  listEditableSkills: listEditableSkillsMock,
  saveWorkspaceSkill: mock(async () => ({ skill: {} })),
  sidecarCall: mock(async () => undefined),
}

function getDesktopApiMocks() {
  return (globalThis as any).__lumeDesktopApiMocks ?? {}
}

mock.module('@/lib/desktop-api', () => ({
  analyzeSkillImprovement: (...args: Parameters<typeof analyzeSkillImprovementMock>) =>
    getDesktopApiMocks().analyzeSkillImprovement?.(...args),
  applySkillImprovement: (...args: unknown[]) => getDesktopApiMocks().applySkillImprovement?.(...args),
  deleteWorkspaceSkill: (...args: unknown[]) => getDesktopApiMocks().deleteWorkspaceSkill?.(...args),
  getEditableSkill: (...args: Parameters<typeof getEditableSkillMock>) =>
    getDesktopApiMocks().getEditableSkill?.(...args),
  getSkillMarketCatalog: (...args: Parameters<typeof getSkillMarketCatalogMock>) =>
    getDesktopApiMocks().getSkillMarketCatalog?.(...args),
  getMcpConfig: (...args: unknown[]) => getDesktopApiMocks().getMcpConfig?.(...args),
  getMcpStatus: (...args: unknown[]) => getDesktopApiMocks().getMcpStatus?.(...args),
  savePathAs: mock(async () => ({ path: null })),
  saveBinaryFileDialog: mock(async () => ({ path: null })),
  localFilePreviewUrl: (path: string) => `asset://${path}`,
  listSkillVersions: (...args: Parameters<typeof listSkillVersionsMock>) =>
    getDesktopApiMocks().listSkillVersions?.(...args),
  listEditableSkills: (...args: Parameters<typeof listEditableSkillsMock>) =>
    getDesktopApiMocks().listEditableSkills?.(...args),
  openExternal: mock(async () => undefined),
  openInSystem: mock(async () => undefined),
  revealPathInSystem: mock(async () => undefined),
  restoreSkillVersion: (...args: unknown[]) => getDesktopApiMocks().restoreSkillVersion?.(...args),
  saveFilePathDialog: mock(async () => ({ path: null })),
  saveTextFileDialog: mock(async () => ({ path: null })),
  saveWorkspaceSkill: (...args: unknown[]) => getDesktopApiMocks().saveWorkspaceSkill?.(...args),
  sidecarCall: (...args: unknown[]) => getDesktopApiMocks().sidecarCall?.(...args),
  writeClipboardText: mock(async () => undefined),
}))

mock.module('@/lib/desktop-api/lume-config', () => ({
  getEffectiveLumeConfig: (...args: Parameters<typeof getEffectiveLumeConfigMock>) =>
    getEffectiveLumeConfigMock(...args),
  updatePermissionsSection: mock(async (permissions: unknown) => ({
    version: 1 as const,
    sourcePath: '/tmp/lume.yaml',
    permissions,
  })),
  updateSkillsConfig: mock(async (skills: unknown) => ({
    version: 1 as const,
    sourcePath: '/tmp/lume.yaml',
    skills,
  })),
}))

const { SkillSettingsView } = await import('./SkillSettingsView')
const { pendingSkillImprovementSuggestionsAtom } = await import('@/atoms')

class FakeEventTarget {
  parentNode: FakeEventTarget | null = null
  childNodes: FakeEventTarget[] = []
  private listeners = new Map<string, Set<EventListener>>()

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
    if (index === -1) {
      this.childNodes.push(node)
    } else {
      this.childNodes.splice(index, 0, node)
    }
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
    Object.defineProperty(event, 'target', { value: event.target ?? this, configurable: true })
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
    if (value !== '') {
      this.appendChild(this.ownerDocument.createTextNode(value))
    }
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
    HTMLIFrameElement: class HTMLIFrameElement extends FakeElement {},
    Text: FakeTextNode,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
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
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function findElementByAttribute(node: FakeEventTarget, name: string, value: string): FakeElement | null {
  if (node instanceof FakeElement && node.attributes.get(name) === value) {
    return node
  }
  for (const child of node.childNodes) {
    const result = findElementByAttribute(child, name, value)
    if (result) return result
  }
  return null
}

function findElementByText(node: FakeEventTarget, text: string): FakeElement | null {
  if (node instanceof FakeElement && node.textContent === text) {
    return node
  }
  for (const child of node.childNodes) {
    const result = findElementByText(child, text)
    if (result) return result
  }
  return null
}

describe('SkillSettingsView', () => {
  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    ;(globalThis as any).__lumeDesktopApiMocks = {
      analyzeSkillImprovement: analyzeSkillImprovementMock,
      applySkillImprovement: mock(async () => ({ success: true })),
      deleteWorkspaceSkill: mock(async () => ({ ok: true })),
      getEditableSkill: getEditableSkillMock,
      getMcpConfig: mock(async () => ({ servers: {} })),
      getMcpStatus: mock(async () => ({ servers: {} })),
      listSkillVersions: listSkillVersionsMock,
      listEditableSkills: listEditableSkillsMock,
      restoreSkillVersion: mock(async () => ({ success: true })),
      saveWorkspaceSkill: mock(async () => ({ skill: {} })),
      sidecarCall: mock(async () => undefined),
    }
    listEditableSkillsMock.mockClear()
    listEditableSkillsMock.mockImplementation(async () => defaultEditableSkills())
    getEditableSkillMock.mockClear()
    listSkillVersionsMock.mockClear()
    analyzeSkillImprovementMock.mockClear()
    getEffectiveLumeConfigMock.mockClear()
    getDefaultStore().set(pendingSkillImprovementSuggestionsAtom, [])
  })

  test('keeps system tools visible while editing a skill', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(<SkillSettingsView workspaceSlug="demo" onOpenMarket={() => {}} />)
        await flush()
      })

      expect(container.textContent).toContain('Skill 生成器')
      expect(container.textContent).not.toContain('Market Review')
      expect(container.textContent).toContain('系统工具')

      const editButton = findElementByAttribute(container, 'title', '编辑技能')
      expect(editButton).not.toBeNull()

      await act(async () => {
        editButton!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(container.textContent).toContain('编辑「Skill 生成器」')
      expect(container.textContent).toContain('系统工具')
      expect(container.textContent).toContain('read_file')
      expect(container.textContent).toContain('agent_spawn')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('passes cwd when loading Alice-compatible project skills', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(<SkillSettingsView workspaceSlug="demo" cwd="/tmp/current-project" onOpenMarket={() => {}} />)
        await flush()
      })

      expect(listEditableSkillsMock).toHaveBeenCalledWith('demo', '/tmp/current-project')
      expect(container.textContent).toContain('当前项目')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('defaults to the current project skill scope when cwd is available', async () => {
    listEditableSkillsMock.mockImplementation(async () => [
      {
        slug: 'project-planner',
        name: 'Project Planner',
        storageScope: 'project' as const,
        managementSurface: 'settings' as const,
        description: 'Project-local Alice skill',
      },
      {
        slug: 'workspace-helper',
        name: 'Workspace Helper',
        storageScope: 'workspace' as const,
        managementSurface: 'settings' as const,
        description: 'Workspace-local Lume skill',
      },
    ])
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(<SkillSettingsView workspaceSlug="demo" cwd="/tmp/current-project" onOpenMarket={() => {}} />)
        await flush()
      })

      expect(container.textContent).toContain('当前项目 (.alice/skills/)技能')
      expect(container.textContent).toContain('Project Planner')
      expect(container.textContent).not.toContain('Workspace Helper')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('switches to the current project scope when cwd resolves after settings opens', async () => {
    listEditableSkillsMock.mockImplementation(async () => [
      {
        slug: 'project-planner',
        name: 'Project Planner',
        storageScope: 'project' as const,
        managementSurface: 'settings' as const,
        description: 'Project-local Alice skill',
      },
      {
        slug: 'workspace-helper',
        name: 'Workspace Helper',
        storageScope: 'workspace' as const,
        managementSurface: 'settings' as const,
        description: 'Workspace-local Lume skill',
      },
    ])
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(<SkillSettingsView workspaceSlug="demo" cwd={null} onOpenMarket={() => {}} />)
        await flush()
      })

      expect(container.textContent).toContain('Lume 工作区技能')

      await act(async () => {
        root!.render(<SkillSettingsView workspaceSlug="demo" cwd="/tmp/current-project" onOpenMarket={() => {}} />)
        await flush()
      })

      expect(container.textContent).toContain('当前项目 (.alice/skills/)技能')
      expect(container.textContent).toContain('Project Planner')
      expect(container.textContent).not.toContain('Workspace Helper')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('shows skill evolution controls in settings editor and preserves storage scope for analysis', async () => {
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(<SkillSettingsView workspaceSlug="demo" onOpenMarket={() => {}} />)
        await flush()
      })

      const editButton = findElementByAttribute(container, 'title', '编辑技能')
      expect(editButton).not.toBeNull()

      await act(async () => {
        editButton!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(container.textContent).toContain('技能进化')
      expect(container.textContent).toContain('版本历史')
      expect(container.textContent).toContain('SKILL_20260605_010203_abcd.md')
      expect(listSkillVersionsMock).toHaveBeenCalledWith({
        workspaceSlug: 'demo',
        skillSlug: 'skill-creator',
        storageScope: 'workspace',
      })

      const analyzeButton = findElementByAttribute(container, 'title', '分析技能改进')
      expect(analyzeButton).not.toBeNull()

      await act(async () => {
        analyzeButton!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(analyzeSkillImprovementMock).toHaveBeenCalledWith({
        workspaceSlug: 'demo',
        skillSlug: 'skill-creator',
        storageScope: 'workspace',
      })
      expect(container.textContent).toContain('收窄到创建或优化 skill 的请求')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('shows pending thread skill improvement suggestions in the matching settings editor', async () => {
    getDefaultStore().set(pendingSkillImprovementSuggestionsAtom, [{
      key: 'demo:workspace:skill-creator',
      workspaceSlug: 'demo',
      storageScope: 'workspace',
      skillSlug: 'skill-creator',
      usageCount: 1,
      analyzedSessionIds: ['thread-1'],
      updates: [
        { section: '触发条件', change: '来自最近会话的建议', reason: '最近使用记录发现误触发' },
      ],
    }])
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(<SkillSettingsView workspaceSlug="demo" onOpenMarket={() => {}} />)
        await flush()
      })

      const editButton = findElementByAttribute(container, 'title', '编辑技能')
      expect(editButton).not.toBeNull()

      await act(async () => {
        editButton!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(container.textContent).toContain('来自最近会话的建议')
      expect(container.textContent).toContain('最近使用记录发现误触发')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('matches pending project skill improvement suggestions by cwd', async () => {
    ;(globalThis as any).__lumeDesktopApiMocks = {
      ...(globalThis as any).__lumeDesktopApiMocks,
      listEditableSkills: mock(async () => [
        {
          slug: 'planner',
          name: 'Project Planner',
          storageScope: 'project' as const,
          managementSurface: 'settings' as const,
          description: 'Project planning skill',
        },
      ]),
      getEditableSkill: mock(async () => ({
        skill: {
          slug: 'planner',
          name: 'Project Planner',
          storageScope: 'project' as const,
          description: 'Project planning skill',
        },
        content: '---\nname: Project Planner\n---\n\nPrompt body.',
      })),
    }
    getDefaultStore().set(pendingSkillImprovementSuggestionsAtom, [
      {
        key: 'demo:project:/tmp/other-project:planner',
        workspaceSlug: 'demo',
        storageScope: 'project',
        cwd: '/tmp/other-project',
        skillSlug: 'planner',
        usageCount: 1,
        analyzedSessionIds: ['thread-1'],
        updates: [
          { section: '触发条件', change: '错误项目建议', reason: '不应显示' },
        ],
      },
      {
        key: 'demo:project:/tmp/current-project:planner',
        workspaceSlug: 'demo',
        storageScope: 'project',
        cwd: '/tmp/current-project',
        skillSlug: 'planner',
        usageCount: 1,
        analyzedSessionIds: ['thread-2'],
        updates: [
          { section: '触发条件', change: '当前项目建议', reason: 'cwd 匹配' },
        ],
      },
    ])
    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(<SkillSettingsView workspaceSlug="demo" cwd="/tmp/current-project" onOpenMarket={() => {}} />)
        await flush()
      })

      const projectTab = findElementByText(container, '当前项目 (.alice/skills/)')
      expect(projectTab).not.toBeNull()

      await act(async () => {
        projectTab!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      const editButton = findElementByAttribute(container, 'title', '编辑技能')
      expect(editButton).not.toBeNull()

      await act(async () => {
        editButton!.dispatchEvent(new Event('click', { bubbles: true }))
        await flush()
      })

      expect(container.textContent).toContain('当前项目建议')
      expect(container.textContent).toContain('cwd 匹配')
      expect(container.textContent).not.toContain('错误项目建议')
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
