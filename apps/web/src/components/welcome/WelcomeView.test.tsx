import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import {
  activeTabIdAtom,
  agentPlanModePhaseAtom,
  agentRuntimeEventsAtom,
  agentSidePanelViewAtom,
  agentStreamingStatesAtom,
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  tabsAtom,
} from '@/atoms'
import { AGENT_IPC_CHANNELS } from '@lume/shared'

mock.restore()

let editorText = ''
let latestSurfaceProps: any = null
let effectiveThinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'max' | undefined
let effectivePermissionMode: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | undefined

const mockEditor = {
  getText: () => editorText,
  commands: {
    clearContent: () => {
      editorText = ''
    },
    insertContent: (value: string) => {
      editorText = value
    },
    focus: () => {},
  },
}

const sidecarCallMock = mock(async (command: string, payload?: Record<string, unknown>) => {
  switch (command) {
    case AGENT_IPC_CHANNELS.CREATE_THREAD:
      return {
        id: 'created-thread',
        title: '新会话',
        workspaceId: payload?.workspaceId,
        pinned: false,
        createdAt: 100,
        updatedAt: 100,
      }
    case AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD:
      return undefined
    default:
      throw new Error(`Unexpected sidecarCall: ${command}`)
  }
})

const agentSendMock = mock(async () => undefined)
const getQuickInputContextMock = mock(async () => ({ status: 'unavailable' }))

mock.module('@tiptap/react', () => ({
  useEditor: () => mockEditor,
  ReactRenderer: class ReactRenderer {
    element = null
    updateProps() {}
    destroy() {}
  },
}))

mock.module('@tiptap/starter-kit', () => ({
  default: {
    configure: () => ({}),
  },
}))

mock.module('@tiptap/extension-placeholder', () => ({
  default: {
    configure: () => ({}),
  },
}))

mock.module('sonner', () => ({
  toast: {
    error: () => {},
    success: () => {},
  },
}))

mock.module('@/lib/desktop-api', () => ({
  sidecarCall: (...args: Parameters<typeof sidecarCallMock>) =>
    ((globalThis as any).__lumeDesktopSidecarCall ?? sidecarCallMock)(...args),
  agentSend: (...args: Parameters<typeof agentSendMock>) =>
    ((globalThis as any).__lumeDesktopAgentSend ?? agentSendMock)(...args),
  openFileDialog: () =>
    (globalThis as any).__lumeDesktopOpenFileDialog?.() ?? Promise.resolve({ files: [] }),
  openFolderDialog: async () => ({ path: null }),
  getQuickInputContext: () => getQuickInputContextMock(),
  openInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  saveFilePathDialog: async () => ({ path: null }),
  copyFile: async () => undefined,
  writeClipboardText: async () => undefined,
  onSidecarEvent: async () => () => {},
  executeTaskContract: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopExecuteTaskContract?.(...args) ?? Promise.resolve({ ok: true }),
  getAgentRunTrace: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopGetAgentRunTrace?.(...args) ?? Promise.resolve({ trace: null }),
  listAgentRunStates: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopListAgentRunStates?.(...args) ?? Promise.resolve({ runs: [] }),
  getMcpConfig: async () => ({ mcpServers: {} }),
  saveMcpConfig: async () => ({ mcpServers: {} }),
  getMcpStatus: async () => ({ servers: [] }),
  testMcpServer: async () => ({ ok: true }),
  listMcpResources: async () => ({ resources: [] }),
  readMcpResource: async () => ({ contents: [] }),
  callMcpToolDiagnostic: async () => ({ content: [] }),
  getSkillMarketCatalog: async () => ({ skills: [] }),
  updateSkillsConfig: async () => ({}),
}))

mock.module('@/lib/desktop-api/lume-config', () => ({
  getEffectiveLumeConfig: async () => ({
    agent: {
      ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
      ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
    },
  }),
  updateAgentThinkingLevel: async (value: string) => {
    effectiveThinkingLevel = value as typeof effectiveThinkingLevel
    return { agent: { thinkingLevel: value } }
  },
}))

mock.module('@/components/agent/ThinkingLevelPicker', () => ({
  ThinkingLevelPicker: () => <div>thinking-level-picker</div>,
}))

mock.module('@/components/agent/PermissionModePicker', () => ({
  PermissionModePicker: (props: unknown) => <div data-permission-picker={JSON.stringify(props)}>permission-mode-picker</div>,
}))

mock.module('@/components/workspace/CreateWorkspaceDialog', () => ({
  CreateWorkspaceDialog: () => null,
}))

mock.module('./WelcomeModelPicker', () => ({
  WelcomeModelPicker: () => <div>welcome-model-picker</div>,
}))

mock.module('./WorkspaceSelector', () => ({
  WorkspaceSelector: () => <div>workspace-selector</div>,
}))

mock.module('./LumeWelcomeSurface', () => ({
  LumeWelcomeSurface: (props: unknown) => {
    latestSurfaceProps = props
    return <div>welcome-surface</div>
  },
}))

const { WelcomeView } = await import('./WelcomeView')

class FakeEventTarget {
  parentNode: FakeEventTarget | null = null
  childNodes: FakeEventTarget[] = []

  appendChild(node: FakeEventTarget) {
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  insertBefore(node: FakeEventTarget, before: FakeEventTarget | null) {
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
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

  contains(target: unknown) {
    if (target === this) return true
    return this.childNodes.some((child) => child.contains(target))
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

  addEventListener() {}

  removeEventListener() {}

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
    HTMLIFrameElement: class HTMLIFrameElement extends FakeElement {},
    Text: FakeTextNode,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
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
  await Promise.resolve()
  await Promise.resolve()
}

describe('WelcomeView', () => {
  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    editorText = ''
    latestSurfaceProps = null
    effectiveThinkingLevel = undefined
    effectivePermissionMode = undefined
    ;(globalThis as any).__lumeDesktopSidecarCall = sidecarCallMock
    ;(globalThis as any).__lumeDesktopAgentSend = agentSendMock
    ;(globalThis as any).__lumeDesktopOpenFileDialog = async () => ({ files: [] })
    sidecarCallMock.mockClear()
    agentSendMock.mockClear()
    getQuickInputContextMock.mockClear()
    getQuickInputContextMock.mockImplementation(async () => ({ status: 'unavailable' }))
  })

  afterEach(async () => {
    await flush()
    delete (globalThis as any).__lumeDesktopSidecarCall
    delete (globalThis as any).__lumeDesktopAgentSend
    delete (globalThis as any).__lumeDesktopOpenFileDialog
  })

  test('resyncs hero copy and the next send when workspaceId changes on a mounted welcome tab', async () => {
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: '品牌工作区',
        slug: 'brand-workspace',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'workspace-2',
        name: '自动化工作区',
        slug: 'automation-workspace',
        createdAt: 2,
        updatedAt: 2,
      },
    ])
    store.set(agentThreadsAtom, [
      {
        id: 'thread-1',
        title: '品牌欢迎线程',
        workspaceId: 'workspace-1',
        pinned: false,
        createdAt: 10,
        updatedAt: 20,
      },
      {
        id: 'thread-2',
        title: '自动化欢迎线程',
        workspaceId: 'workspace-2',
        pinned: false,
        createdAt: 30,
        updatedAt: 40,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(tabsAtom, [{ id: '__welcome__', type: 'welcome', title: '新会话', workspaceId: 'workspace-1' }])
    store.set(activeTabIdAtom, '__welcome__')

    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <WelcomeView workspaceId="workspace-1" />
          </Provider>,
        )
        await flush()
      })

      expect(latestSurfaceProps?.workspaceSelector.props.selectedId).toBe('workspace-1')
      expect(latestSurfaceProps?.model.hero.subtitle).toContain('品牌工作区')

      await act(async () => {
        root!.render(
          <Provider store={store}>
            <WelcomeView workspaceId="workspace-2" />
          </Provider>,
        )
        await flush()
      })

      expect(latestSurfaceProps?.workspaceSelector.props.selectedId).toBe('workspace-2')
      expect(latestSurfaceProps?.model.hero.subtitle).toContain('自动化工作区')

      editorText = '重新定位后的欢迎消息'

      await act(async () => {
        await latestSurfaceProps.onSend()
        await flush()
      })

      expect(sidecarCallMock).toHaveBeenCalledWith(
        AGENT_IPC_CHANNELS.CREATE_THREAD,
        expect.objectContaining({ workspaceId: 'workspace-2' }),
      )
      expect(agentSendMock).toHaveBeenCalledTimes(1)
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount()
          await flush()
        })
        root = null
      }
      cleanup()
    }
  })

  test('attaches the pre-captured active app to the first message from the welcome composer', async () => {
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: '默认工作区',
        slug: 'default-workspace',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(tabsAtom, [{ id: '__welcome__', type: 'welcome', title: '新会话', workspaceId: 'workspace-1' }])
    store.set(activeTabIdAtom, '__welcome__')
    getQuickInputContextMock.mockImplementation(async () => {
      return {
        status: 'ok',
        snapshotId: 'snapshot:notepad',
        app: { id: 'notepad.exe', name: 'Notepad' },
        window: { id: 'window:notepad', title: '周报.txt - Notepad' },
        capturedAt: Date.now(),
      }
    })

    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <WelcomeView workspaceId="workspace-1" />
          </Provider>,
        )
        await flush()
      })

      await act(async () => {
        await latestSurfaceProps.onAttachMenuOpen()
        await flush()
      })

      expect(latestSurfaceProps.desktopContextTarget).toEqual({
        snapshotId: 'snapshot:notepad',
        app: { id: 'notepad.exe', name: 'Notepad' },
        window: { id: 'window:notepad', title: '周报.txt - Notepad' },
        capturedAt: expect.any(Number),
      })

      await act(async () => {
        latestSurfaceProps.onSelectDesktopContextTarget(latestSurfaceProps.desktopContextTarget)
        await flush()
      })
      editorText = '根据当前文档写一份周报'

      await act(async () => {
        await latestSurfaceProps.onSend()
        await flush()
      })

      expect(agentSendMock).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'created-thread',
        userMessage: '根据当前文档写一份周报',
        messageMetadata: {
          desktopContextSnapshotId: 'snapshot:notepad',
          desktopApp: { id: 'notepad.exe', name: 'Notepad' },
          desktopWindow: { id: 'window:notepad', title: '周报.txt - Notepad' },
        },
      }))
      expect(store.get(tabsAtom).find((tab) => tab.id === 'created-thread')?.desktopContextTarget).toEqual({
        snapshotId: 'snapshot:notepad',
        app: { id: 'notepad.exe', name: 'Notepad' },
        window: { id: 'window:notepad', title: '周报.txt - Notepad' },
        capturedAt: expect.any(Number),
      })
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount()
          await flush()
        })
        root = null
      }
      cleanup()
    }
  })

  test('mirrors the selected model into both welcome pickers and uses it for new threads', async () => {
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: '默认工作区',
        slug: 'default-workspace',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(tabsAtom, [{ id: '__welcome__', type: 'welcome', title: '新会话', workspaceId: 'workspace-1' }])
    store.set(activeTabIdAtom, '__welcome__')

    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <WelcomeView workspaceId="workspace-1" />
          </Provider>,
        )
        await flush()
      })

      await act(async () => {
        latestSurfaceProps.composerModelPicker.props.onModelChange('openai/gpt-5-mini', 'channel-openai', 'gpt-5-mini')
        await flush()
      })

      expect(latestSurfaceProps.modelPicker.props.selectedModelRef).toBe('openai/gpt-5-mini')
      expect(latestSurfaceProps.modelPicker.props.selectedChannelId).toBe('channel-openai')
      expect(latestSurfaceProps.composerModelPicker.props.selectedModelRef).toBe('openai/gpt-5-mini')
      expect(latestSurfaceProps.composerModelPicker.props.selectedChannelId).toBe('channel-openai')

      editorText = '用选中的模型开始'

      await act(async () => {
        await latestSurfaceProps.onSend()
        await flush()
      })

      expect(sidecarCallMock).toHaveBeenCalledWith(
        AGENT_IPC_CHANNELS.CREATE_THREAD,
        expect.objectContaining({
          workspaceId: 'workspace-1',
          modelRef: 'openai/gpt-5-mini',
          channelId: 'channel-openai',
          modelId: 'gpt-5-mini',
        }),
      )
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount()
          await flush()
        })
        root = null
      }
      cleanup()
    }
  })

  test('persists the selected thinking level and uses it when creating a new thread', async () => {
    effectiveThinkingLevel = 'medium'
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: '默认工作区',
        slug: 'default-workspace',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(tabsAtom, [{ id: '__welcome__', type: 'welcome', title: '新会话', workspaceId: 'workspace-1' }])
    store.set(activeTabIdAtom, '__welcome__')

    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <WelcomeView workspaceId="workspace-1" />
          </Provider>,
        )
        await flush()
      })

      const thinkingPickerProps = latestSurfaceProps.thinkingLevelPicker.props
      expect(thinkingPickerProps.value).toBe('medium')

      await act(async () => {
        await thinkingPickerProps.onChange('high')
        await flush()
      })

      expect(effectiveThinkingLevel).toBe('high')
      expect(latestSurfaceProps.thinkingLevelPicker.props.value).toBe('high')

      editorText = '用高思考等级开始'

      await act(async () => {
        await latestSurfaceProps.onSend()
        await flush()
      })

      expect(agentSendMock).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'created-thread',
        userMessage: '用高思考等级开始',
        thinkingLevel: 'high',
      }))
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount()
          await flush()
        })
        root = null
      }
      cleanup()
    }
  })

  test('uses the selected permission mode for the welcome send without persisting it globally', async () => {
    effectivePermissionMode = 'acceptEdits'
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: '默认工作区',
        slug: 'default-workspace',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(tabsAtom, [{ id: '__welcome__', type: 'welcome', title: '新会话', workspaceId: 'workspace-1' }])
    store.set(activeTabIdAtom, '__welcome__')

    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <WelcomeView workspaceId="workspace-1" />
          </Provider>,
        )
        await flush()
      })

      const permissionPickerProps = latestSurfaceProps.permissionModePicker.props
      expect(permissionPickerProps.value).toBe('acceptEdits')

      await act(async () => {
        permissionPickerProps.onChange('plan')
        await flush()
      })

      expect(effectivePermissionMode).toBe('acceptEdits')
      expect(latestSurfaceProps.permissionModePicker.props.value).toBe('plan')

      editorText = '先规划欢迎页任务'

      await act(async () => {
        await latestSurfaceProps.onSend()
        await flush()
      })

      expect(agentSendMock).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'created-thread',
        userMessage: '先规划欢迎页任务',
        permissionMode: 'plan',
      }))
      expect(store.get(activeTabIdAtom)).toBe('created-thread')
      expect(store.get(agentStreamingStatesAtom)['created-thread']).toBe('streaming')
      expect(store.get(agentPlanModePhaseAtom)['created-thread']).toEqual({
        threadId: 'created-thread',
        phase: 'planning',
      })
      expect(store.get(agentSidePanelViewAtom)['created-thread']).toBeUndefined()
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount()
          await flush()
        })
        root = null
      }
      cleanup()
    }
  })

  test('saves welcome attachments to the created thread and sends them with the first message', async () => {
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: '默认工作区',
        slug: 'default-workspace',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(tabsAtom, [{ id: '__welcome__', type: 'welcome', title: '新会话', workspaceId: 'workspace-1' }])
    store.set(activeTabIdAtom, '__welcome__')

    ;(globalThis as any).__lumeDesktopOpenFileDialog = async () => ({
      files: [
        {
          filename: 'screen.png',
          mediaType: 'image/png',
          size: 12,
          sourcePath: '/tmp/screen.png',
          data: 'abc123',
        },
      ],
    })
    ;(globalThis as any).__lumeDesktopSidecarCall = mock(async (command: string, payload?: Record<string, unknown>) => {
      if (command === AGENT_IPC_CHANNELS.CREATE_THREAD) {
        return {
          id: 'created-thread',
          title: '新会话',
          workspaceId: payload?.workspaceId,
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        }
      }
      if (command === AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD) {
        return [{ filename: 'screen.png', targetPath: '/thread/screen.png', threadPath: 'screen.png' }]
      }
      throw new Error(`Unexpected sidecarCall: ${command}`)
    })

    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <WelcomeView workspaceId="workspace-1" />
          </Provider>,
        )
        await flush()
      })

      await act(async () => {
        await latestSurfaceProps.onAttach()
        await flush()
      })

      expect(latestSurfaceProps.pendingFiles).toEqual([
        expect.objectContaining({
          filename: 'screen.png',
          mediaType: 'image/png',
          size: 12,
          sourcePath: '/tmp/screen.png',
          data: 'abc123',
          previewUrl: 'data:image/png;base64,abc123',
        }),
      ])

      editorText = '分析这张图'

      await act(async () => {
        await latestSurfaceProps.onSend()
        await flush()
      })

      const saveCall = ((globalThis as any).__lumeDesktopSidecarCall as ReturnType<typeof mock>).mock.calls
        .find((call) => call[0] === AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD)
      expect(saveCall?.[1]).toEqual({
        threadId: 'created-thread',
        workspaceSlug: 'default-workspace',
        files: [{ filename: 'screen.png', sourcePath: '/tmp/screen.png', data: 'abc123' }],
      })

      expect(agentSendMock).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'created-thread',
        userMessage: '分析这张图',
        messageAttachments: [
          expect.objectContaining({
            filename: 'screen.png',
            mediaType: 'image/png',
            size: 12,
            threadPath: 'screen.png',
          }),
        ],
      }))
      expect(store.get(agentRuntimeEventsAtom)['created-thread']?.events[0]).toEqual(expect.objectContaining({
        type: 'message.user.submitted',
        attachments: [
          expect.objectContaining({
            filename: 'screen.png',
            threadPath: 'screen.png',
          }),
        ],
      }))
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount()
          await flush()
        })
        root = null
      }
      cleanup()
    }
  })

  test('allows starting a thread with welcome attachments even when the editor is empty', async () => {
    const store = createStore()
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: '默认工作区',
        slug: 'default-workspace',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(tabsAtom, [{ id: '__welcome__', type: 'welcome', title: '新会话', workspaceId: 'workspace-1' }])
    store.set(activeTabIdAtom, '__welcome__')

    ;(globalThis as any).__lumeDesktopOpenFileDialog = async () => ({
      files: [{ filename: 'brief.pdf', mediaType: 'application/pdf', size: 20, sourcePath: '/tmp/brief.pdf' }],
    })
    ;(globalThis as any).__lumeDesktopSidecarCall = mock(async (command: string, payload?: Record<string, unknown>) => {
      if (command === AGENT_IPC_CHANNELS.CREATE_THREAD) {
        return {
          id: 'created-thread',
          title: '新会话',
          workspaceId: payload?.workspaceId,
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        }
      }
      if (command === AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD) {
        return [{ filename: 'brief.pdf', targetPath: '/thread/brief.pdf', threadPath: 'brief.pdf' }]
      }
      throw new Error(`Unexpected sidecarCall: ${command}`)
    })

    const { container, cleanup } = installFakeDom()
    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <WelcomeView workspaceId="workspace-1" />
          </Provider>,
        )
        await flush()
      })

      await act(async () => {
        await latestSurfaceProps.onAttach()
        await flush()
      })

      expect(latestSurfaceProps.hasText).toBe(true)

      await act(async () => {
        await latestSurfaceProps.onSend()
        await flush()
      })

      expect(agentSendMock).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'created-thread',
        userMessage: '请解读这些附件。',
        messageAttachments: [
          expect.objectContaining({
            filename: 'brief.pdf',
            threadPath: 'brief.pdf',
          }),
        ],
      }))
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount()
          await flush()
        })
        root = null
      }
      cleanup()
    }
  })
})
