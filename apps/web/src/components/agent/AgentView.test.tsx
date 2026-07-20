import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import {
  activeTabIdAtom,
  agentPendingInteractiveAtom,
  agentStreamingStatesAtom,
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  rightPanelLayoutAtom,
  rightPanelFileWorkspacesAtom,
  rightPanelWorkspacesAtom,
  tabsAtom,
} from '@/atoms'
import { AGENT_IPC_CHANNELS, type FileRef, type GuardedFileRef, type GuardedFileRefValidationResult } from '@lume/shared'
import type { OpenThreadFile } from './AgentFileReference'

mock.restore()

let latestAgentMessagesProps: {
  onOpenThreadFile?: OpenThreadFile
  onOpenThreadImage?: (attachment: {
    id: string
    filename: string
    mediaType: string
    size: number
    threadPath: string
    fileRef?: FileRef
  }) => void
  onOpenMemorySource?: (path: string, fileRef?: FileRef) => void
} | null = null
let latestAgentInputProps: Record<string, unknown> | null = null
const toastErrorMock = mock((_message: string) => undefined)

const sidecarCallMock = mock(async (channel: string, payload?: Record<string, unknown>) => {
  if (channel === AGENT_IPC_CHANNELS.READ_FILE) {
    return {
      content: '# Plan\n\nReview this plan before execution.',
      truncated: false,
    }
  }
  if (channel === AGENT_IPC_CHANNELS.GET_THREAD_PATH) {
    return '/data/threads/thread-1'
  }
  if (channel === AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD) {
    return undefined
  }
  if (channel === AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF) {
    if (payload?.recordKind === 'memory-source') {
      return { source: 'memory', scopeId: 'workspace:workspace', relativePath: payload.legacyRelativePath }
    }
    return { source: 'session', scopeId: 'thread-1', relativePath: payload?.legacyRelativePath }
  }
  throw new Error(`Unexpected sidecarCall: ${channel} ${JSON.stringify(payload)}`)
})

mock.module('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: () => {},
  },
}))

mock.module('@/lib/desktop-api', () => ({
  abortStagedAttachment: async () => undefined,
  sidecarCall: (...args: Parameters<typeof sidecarCallMock>) =>
    ((globalThis as any).__lumeDesktopSidecarCall ?? sidecarCallMock)(...args),
  agentSend: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopAgentSend?.(...args) ?? Promise.resolve(undefined),
  createThread: () => Promise.resolve({ id: 'thread-1' }),
  clearCache: () => Promise.resolve({ cleared: [], skipped: [] }),
  copyFile: () => Promise.resolve(undefined),
  createFilePreviewScope: () => Promise.resolve({ token: 'preview', url: 'lume-file://preview', expiresAt: 0 }),
  createGuardedFilePreviewScope: () => Promise.resolve({ token: 'guarded-preview', url: 'lume-file://preview', expiresAt: 0 }),
  openFileDialog: () =>
    (globalThis as any).__lumeDesktopOpenFileDialog?.() ?? Promise.resolve({ files: [] }),
  localFilePreviewUrl: (path: string) => `asset://${path}`,
  openInSystem: () => Promise.resolve(undefined),
  openFileRefInSystem: () => Promise.resolve(undefined),
  openGuardedFileRefInSystem: () => Promise.resolve(undefined),
  revealPathInSystem: () => Promise.resolve(undefined),
  revealFileRefInSystem: () => Promise.resolve(undefined),
  revealGuardedFileRefInSystem: () => Promise.resolve(undefined),
  revokeFilePreviewScope: () => Promise.resolve(undefined),
  saveFilePathDialog: () => Promise.resolve({ path: '/tmp/lume.txt' }),
  saveGuardedFileRefAs: () => Promise.resolve({ path: '/tmp/lume.txt' }),
  saveTextFileDialog: () => Promise.resolve({ path: '/tmp/lume.txt' }),
  writeClipboardText: () => Promise.resolve(undefined),
  writeClipboardImage: () => Promise.resolve(undefined),
  statFilePaths: () =>
    (globalThis as any).__lumeDesktopStatFilePaths?.() ?? Promise.resolve({ files: [] }),
  openExternal: () => Promise.resolve(undefined),
  executeTaskContract: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopExecuteTaskContract?.(...args) ?? Promise.resolve({ ok: true }),
  submitTaskApproval: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopSubmitTaskApproval?.(...args) ?? Promise.resolve({ ok: true }),
  getThreadMessageVersions: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopGetThreadMessageVersions?.(...args) ?? Promise.resolve({ messages: [] }),
  getAgentRunTrace: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopGetAgentRunTrace?.(...args) ?? Promise.resolve({ trace: null }),
  listAgentRunStates: (...args: unknown[]) =>
    (globalThis as any).__lumeDesktopListAgentRunStates?.(...args) ?? Promise.resolve({ runs: [] }),
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

mock.module('@/components/file-browser/FileBrowser', () => ({
  FileBrowser: () => <div>file-browser</div>,
}))

mock.module('@/components/file-browser/WorkspaceFileBrowser', () => ({
  WorkspaceFileBrowser: () => <div>workspace-file-browser</div>,
}))

mock.module('./AgentHeader', () => ({
  AgentHeader: () => <div>agent-header</div>,
}))

mock.module('./AgentMessages', () => ({
  AgentMessages: (props: NonNullable<typeof latestAgentMessagesProps>) => {
    latestAgentMessagesProps = props
    return <div>agent-messages</div>
  },
}))

mock.module('./AgentInput', () => ({
  AgentInput: (props: Record<string, unknown>) => {
    latestAgentInputProps = props
    return <div>agent-input</div>
  },
}))

mock.module('./PermissionBanner', () => ({
  PermissionBanner: () => <div>permission-banner</div>,
}))

mock.module('./AskUserBanner', () => ({
  AskUserBanner: () => <div>ask-user-banner</div>,
}))

mock.module('./ErrorBanner', () => ({
  ErrorBanner: () => <div>error-banner</div>,
}))

const { AgentView } = await import('./AgentView')

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
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('AgentView plan approval tab behavior', () => {
  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    latestAgentMessagesProps = null
    ;(globalThis as any).__lumeDesktopSidecarCall = sidecarCallMock
    sidecarCallMock.mockClear()
    toastErrorMock.mockClear()
  })

  afterEach(async () => {
    await flush()
    delete (globalThis as any).__lumeDesktopSidecarCall
  })

  test('shows plan approval as an input overlay without auto-opening the plan file', async () => {
    const { container, cleanup } = installFakeDom()
    const store = createStore()
    store.set(tabsAtom, [
      {
        id: 'thread-1',
        type: 'agent',
        title: 'Research thread',
        threadId: 'thread-1',
      },
    ])
    store.set(activeTabIdAtom, 'thread-1')
    store.set(agentThreadsAtom, [
      {
        id: 'thread-1',
        title: 'Research thread',
        workspaceId: 'workspace-1',
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: 'Workspace',
        slug: 'workspace',
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(agentStreamingStatesAtom, { 'thread-1': 'idle' })
    store.set(rightPanelWorkspacesAtom, {})
    store.set(rightPanelFileWorkspacesAtom, {})
    store.set(rightPanelLayoutAtom, { open: false, mode: 'compact' })
    store.set(agentPendingInteractiveAtom, {
      'thread-1': {
        threadId: 'thread-1',
        taskApprovals: [
          {
            threadId: 'thread-1',
            requestId: 'approval-1',
            contractId: 'contract-1',
            title: 'Review plan',
            message: 'Review the plan before execution',
            stepCount: 1,
            planFilePath: 'plans/deepseek-oss-research.md',
            planVerified: true,
          },
        ],
      },
    })

    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <AgentView threadId="thread-1" />
          </Provider>,
        )
        await flush()
      })

      expect(store.get(activeTabIdAtom)).toBe('thread-1')
      expect(store.get(tabsAtom)).toHaveLength(1)
      expect(container.textContent).toContain('实施此计划?')
      expect(container.textContent).toContain('是，实施此计划')
      expect(sidecarCallMock.mock.calls.some(([channel, payload]) => (
        channel === AGENT_IPC_CHANNELS.READ_FILE &&
        (payload as Record<string, unknown>).threadId === 'thread-1' &&
        (payload as Record<string, unknown>).path === 'plans/deepseek-oss-research.md'
      ))).toBe(false)
      expect(latestAgentMessagesProps?.onOpenThreadFile).toBeDefined()

      await act(async () => {
        latestAgentMessagesProps?.onOpenThreadFile?.('files/research-notes.md')
        await flush()
      })

      expect(store.get(activeTabIdAtom)).toBe('thread-1')
      expect(store.get(rightPanelLayoutAtom)).toEqual({ open: true, mode: 'normal' })
      expect(store.get(rightPanelWorkspacesAtom)['thread-1']).toBeUndefined()
      expect(store.get(rightPanelFileWorkspacesAtom)['thread-1']).toMatchObject({
        activeItem: { kind: 'file' },
        openTabs: [{ ref: { source: 'session', scopeId: 'thread-1', relativePath: 'files/research-notes.md' } }],
      })
      expect(sidecarCallMock.mock.calls.some(([channel, payload]) => (
        channel === AGENT_IPC_CHANNELS.READ_FILE &&
        (payload as Record<string, unknown>).threadId === 'thread-1' &&
        (payload as Record<string, unknown>).path === 'files/research-notes.md'
      ))).toBe(false)

      store.set(rightPanelLayoutAtom, { open: true, mode: 'expanded' })
      await act(async () => {
        latestAgentMessagesProps?.onOpenMemorySource?.('memories/profile.md')
        await flush()
      })

      expect(store.get(rightPanelLayoutAtom)).toEqual({ open: true, mode: 'expanded' })
      expect(store.get(rightPanelWorkspacesAtom)['thread-1']).toBeUndefined()
      expect(store.get(rightPanelFileWorkspacesAtom)['thread-1']).toMatchObject({
        activeItem: { kind: 'file' },
        openTabs: [
          { ref: { source: 'session', relativePath: 'files/research-notes.md' } },
          { ref: { source: 'memory', relativePath: 'memories/profile.md' } },
        ],
      })

      const conversionCount = sidecarCallMock.mock.calls.filter(([channel]) => channel === AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF).length
      await act(async () => {
        latestAgentMessagesProps?.onOpenThreadFile?.('ignored-legacy-path.md', {
          source: 'session', scopeId: 'thread-1', relativePath: 'files/signed.md',
        })
        await flush()
      })
      expect(sidecarCallMock.mock.calls.filter(([channel]) => channel === AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF)).toHaveLength(conversionCount)
      expect(store.get(rightPanelFileWorkspacesAtom)['thread-1'].openTabs.at(-1)?.ref).toEqual({
        source: 'session', scopeId: 'thread-1', relativePath: 'files/signed.md',
      })

      await act(async () => {
        latestAgentMessagesProps?.onOpenMemorySource?.('ignored-memory-citation.md', {
          source: 'memory', scopeId: 'global', relativePath: 'entries/signed.md',
        })
        await flush()
      })
      expect(sidecarCallMock.mock.calls.filter(([channel]) => channel === AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF)).toHaveLength(conversionCount)
      expect(store.get(rightPanelFileWorkspacesAtom)['thread-1'].openTabs.at(-1)?.ref).toEqual({
        source: 'memory', scopeId: 'global', relativePath: 'entries/signed.md',
      })

      ;(globalThis as any).__lumeDesktopSidecarCall = async (channel: string) => {
        if (channel === AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF) throw new Error('legacy conversion failed')
        return sidecarCallMock(channel)
      }
      await act(async () => {
        latestAgentMessagesProps?.onOpenThreadFile?.('missing-legacy.md')
        await flush()
      })
      expect(toastErrorMock).toHaveBeenCalledWith('legacy conversion failed')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('keeps guarded file navigation latest-wins when validations finish out of order', async () => {
    const { container, cleanup } = installFakeDom()
    const store = createStore()
    store.set(tabsAtom, [{ id: 'thread-1', type: 'agent', title: 'Thread', threadId: 'thread-1' }])
    store.set(activeTabIdAtom, 'thread-1')
    store.set(agentThreadsAtom, [{
      id: 'thread-1', title: 'Thread', workspaceId: 'workspace-1', fileContextId: 'context-1',
      pinned: false, createdAt: 1, updatedAt: 2,
    }])
    store.set(agentWorkspacesAtom, [{
      id: 'workspace-1', name: 'Workspace', slug: 'workspace', createdAt: 1, updatedAt: 2,
    }])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(agentStreamingStatesAtom, { 'thread-1': 'idle' })
    store.set(rightPanelFileWorkspacesAtom, {})

    const validationResolvers: Array<(value: GuardedFileRefValidationResult) => void> = []
    ;(globalThis as any).__lumeDesktopSidecarCall = (channel: string, payload?: Record<string, unknown>) => {
      if (channel === AGENT_IPC_CHANNELS.VALIDATE_GUARDED_FILE_REF) {
        return new Promise<GuardedFileRefValidationResult>((resolve) => validationResolvers.push(resolve))
      }
      return sidecarCallMock(channel, payload)
    }
    const guardedRef = (relativePath: string): GuardedFileRef => ({
      ref: { source: 'project', scopeId: 'workspace', relativePath },
      guard: {
        kind: 'project', workspaceSlug: 'workspace', expectedProjectRootFingerprint: 'a'.repeat(64),
        consumerThreadId: 'thread-1',
      },
    })

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(<Provider store={store}><AgentView threadId="thread-1" /></Provider>)
        await flush()
      })

      const firstRef = guardedRef('src/old.ts')
      const secondRef = guardedRef('src/new.ts')
      const first = latestAgentMessagesProps!.onOpenThreadFile!('src/old.ts', undefined, { guardedRef: firstRef })
      const second = latestAgentMessagesProps!.onOpenThreadFile!('src/new.ts', undefined, { guardedRef: secondRef })
      expect(validationResolvers).toHaveLength(2)

      await act(async () => {
        validationResolvers[1]!({ ok: true, entry: { name: 'new.ts', path: 'src/new.ts', isDirectory: false, ref: secondRef.ref } })
        await flush()
      })
      expect(await second).toBe('opened')
      expect(store.get(rightPanelFileWorkspacesAtom)['thread-1']?.openTabs.map((tab) => tab.ref.relativePath))
        .toEqual(['src/new.ts'])

      await act(async () => {
        validationResolvers[0]!({ ok: true, entry: { name: 'old.ts', path: 'src/old.ts', isDirectory: false, ref: firstRef.ref } })
        await flush()
      })
      expect(await first).toBe('superseded')
      expect(store.get(rightPanelFileWorkspacesAtom)['thread-1']?.openTabs.map((tab) => tab.ref.relativePath))
        .toEqual(['src/new.ts'])
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('opens a global image preview from message image attachments', async () => {
    const { container, cleanup } = installFakeDom()
    const store = createStore()
    store.set(tabsAtom, [
      {
        id: 'thread-1',
        type: 'agent',
        title: 'Image thread',
        threadId: 'thread-1',
      },
    ])
    store.set(activeTabIdAtom, 'thread-1')
    store.set(agentThreadsAtom, [
      {
        id: 'thread-1',
        title: 'Image thread',
        workspaceId: 'workspace-1',
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(agentWorkspacesAtom, [
      {
        id: 'workspace-1',
        name: 'Workspace',
        slug: 'workspace',
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(agentStreamingStatesAtom, { 'thread-1': 'idle' })
    store.set(rightPanelWorkspacesAtom, {})
    store.set(rightPanelFileWorkspacesAtom, {})
    store.set(agentPendingInteractiveAtom, {})

    let root: Root | null = createRoot(container as never)

    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <AgentView threadId="thread-1" />
          </Provider>,
        )
        await flush()
      })

      expect(latestAgentMessagesProps?.onOpenThreadImage).toBeDefined()

      await act(async () => {
        latestAgentMessagesProps?.onOpenThreadImage?.({
          id: 'att-image',
          filename: 'screen.png',
          mediaType: 'image/png',
          size: 10,
          threadPath: 'screen.png',
        })
        await flush()
      })

      expect(store.get(rightPanelFileWorkspacesAtom)['thread-1']).toMatchObject({
        activeItem: { kind: 'file' },
        openTabs: [{ ref: { source: 'session', relativePath: 'screen.png' } }],
      })
      expect(sidecarCallMock.mock.calls.some(([channel]) => channel === AGENT_IPC_CHANNELS.GET_THREAD_PATH)).toBe(false)
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

describe('AgentView readOnly replay mode', () => {
  test('passes tab-level desktop context clear action to the input composer', async () => {
    const { container, cleanup } = installFakeDom()
    const store = createStore()
    const target = {
      snapshotId: 'snap-wechat',
      app: { id: 'wechat.exe', name: '微信' },
      window: { id: 'win:wechat', title: '项目群' },
    }
    let cleared = false
    latestAgentInputProps = null
    store.set(tabsAtom, [
      { id: 'thread-1', type: 'agent', title: 'Chat', threadId: 'thread-1' },
    ])
    store.set(activeTabIdAtom, 'thread-1')
    store.set(agentThreadsAtom, [
      {
        id: 'thread-1',
        title: 'Chat',
        workspaceId: 'workspace-1',
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(agentWorkspacesAtom, [
      { id: 'workspace-1', name: 'Workspace', slug: 'workspace', createdAt: 1, updatedAt: 2 },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(agentStreamingStatesAtom, { 'thread-1': 'idle' })
    store.set(rightPanelWorkspacesAtom, {})
    store.set(agentPendingInteractiveAtom, {})

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <AgentView
              threadId="thread-1"
              desktopContextTarget={target}
              onClearDesktopContextTarget={() => { cleared = true }}
            />
          </Provider>,
        )
        await flush()
      })

      expect(latestAgentInputProps?.desktopContextTarget).toEqual(target)
      expect(typeof latestAgentInputProps?.onClearDesktopContextTarget).toBe('function')
      ;(latestAgentInputProps?.onClearDesktopContextTarget as (() => void) | undefined)?.()
      expect(cleared).toBe(true)
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('hides the input composer when readOnly', async () => {
    const { container, cleanup } = installFakeDom()
    const store = createStore()
    store.set(tabsAtom, [
      { id: 'thread-1', type: 'agent', title: 'Replay', threadId: 'thread-1' },
    ])
    store.set(activeTabIdAtom, 'thread-1')
    store.set(agentThreadsAtom, [
      {
        id: 'thread-1',
        title: 'Replay',
        workspaceId: 'workspace-1',
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(agentWorkspacesAtom, [
      { id: 'workspace-1', name: 'Workspace', slug: 'workspace', createdAt: 1, updatedAt: 2 },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(agentStreamingStatesAtom, { 'thread-1': 'idle' })
    store.set(rightPanelWorkspacesAtom, {})
    store.set(agentPendingInteractiveAtom, {})

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <AgentView threadId="thread-1" readOnly />
          </Provider>,
        )
        await flush()
      })

      // AgentInput 被 mock 成 <div>agent-input</div>；只读时不应渲染
      expect(container.textContent).not.toContain('agent-input')
      // 消息流仍应渲染
      expect(container.textContent).toContain('agent-messages')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('renders the input composer by default (regression guard)', async () => {
    const { container, cleanup } = installFakeDom()
    const store = createStore()
    store.set(tabsAtom, [
      { id: 'thread-1', type: 'agent', title: 'Chat', threadId: 'thread-1' },
    ])
    store.set(activeTabIdAtom, 'thread-1')
    store.set(agentThreadsAtom, [
      {
        id: 'thread-1',
        title: 'Chat',
        workspaceId: 'workspace-1',
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(agentWorkspacesAtom, [
      { id: 'workspace-1', name: 'Workspace', slug: 'workspace', createdAt: 1, updatedAt: 2 },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(agentStreamingStatesAtom, { 'thread-1': 'idle' })
    store.set(rightPanelWorkspacesAtom, {})
    store.set(agentPendingInteractiveAtom, {})

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <AgentView threadId="thread-1" />
          </Provider>,
        )
        await flush()
      })

      // 默认（非只读）仍渲染输入框
      expect(container.textContent).toContain('agent-input')
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
