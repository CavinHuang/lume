import { describe, expect, test } from 'bun:test'
import type { FileRef } from '@lume/shared'
import {
  closeFileTab,
  createFileTreeRevealRequest,
  createThreadFileWorkspace,
  disambiguateFileTabLabels,
  fileRefKey,
  getEffectiveThreadFileBindings,
  getFileTreeRevealDirectories,
  openFileTab,
  normalizePersistedRightPanelFileTabs,
  normalizeLineSelection,
  pinPreviewFileTab,
  clearPreviewFileTab,
  previewFileTab,
  reconcileThreadFileWorkspaces,
    removeFileRef,
    setFilePreviewScope,
  settleFileTreeReveal,
  rewriteFileRefPrefix,
} from './right-panel-files-state'

const ref = (relativePath: string, source: FileRef['source'] = 'session', scopeId = 'scope-1'): FileRef => ({
  source,
  scopeId,
  relativePath,
})

describe('right-panel-files-state', () => {
  test('reuses the same normalized Windows FileRef without conflating scopes', () => {
    let state = createThreadFileWorkspace({ workspaceId: 'workspace-1', fileContextId: 'scope-1' })
    state = openFileTab(state, ref('src\\Thing.ts'), { caseInsensitive: true })
    state = openFileTab(state, ref('./SRC/thing.ts'), { caseInsensitive: true })
    state = openFileTab(state, ref('src/thing.ts', 'session', 'scope-2'), { caseInsensitive: true })

    expect(state.openTabs).toHaveLength(2)
    expect(state.activeItem).toEqual({ kind: 'file', tabId: state.openTabs[1]!.id })
    expect(fileRefKey(ref('./SRC/thing.ts'), { caseInsensitive: true })).toBe(
      fileRefKey(ref('src/thing.ts'), { caseInsensitive: true }),
    )
  })

  test('stores a resolved plain FileRef and relocates the same tab while clearing omitted anchors', () => {
    const resolvedRef = { source: 'project' as const, scopeId: 'demo', relativePath: 'src/app.ts' }
    let state = openFileTab(createThreadFileWorkspace({ workspaceId: 'workspace-1' }), resolvedRef, {
      lineSelection: { start: 8, end: 4 },
      navigationRevision: 4,
    })
    expect(state.openTabs[0]).toMatchObject({
      lineSelection: { start: 8, end: 8 },
      navigationRevision: 4,
    })

    state = openFileTab(state, resolvedRef, { lineSelection: { start: 12, end: 14 }, navigationRevision: 5 })
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0]).toMatchObject({ ref: resolvedRef, lineSelection: { start: 12, end: 14 }, navigationRevision: 5 })

    state = openFileTab(state, resolvedRef, { navigationRevision: 6 })
    expect(state.openTabs[0]!.lineSelection).toBeUndefined()
  })

  test('normalizes line selections and explicitly settles runtime-only reveal requests', async () => {
    expect(normalizeLineSelection({ start: -2, end: 0 })).toEqual({ start: 1, end: 1 })
    expect(getFileTreeRevealDirectories(ref('deep/nested/folder'))).toEqual([
      ref(''),
      ref('deep'),
      ref('deep/nested'),
    ])
    const { request, completion } = createFileTreeRevealRequest(ref('deep/folder'), 9, 1_000)
    expect(request).toMatchObject({ navigationRevision: 9, ref: { relativePath: 'deep/folder' } })
    settleFileTreeReveal(request.requestId, { status: 'superseded' })
    await expect(completion).resolves.toEqual({ status: 'superseded' })
  })

  test('binding changes settle an in-flight directory reveal instead of leaving it pending', async () => {
    const { request, completion } = createFileTreeRevealRequest(ref('deep/folder'), 10, 1_000)
    const state = {
      ...createThreadFileWorkspace({ workspaceId: 'workspace-old', fileContextId: 'context-old' }),
      revealRequest: request,
    }

    const result = reconcileThreadFileWorkspaces(
      { 'thread-1': state },
      [{ id: 'thread-1', workspaceId: 'workspace-new', fileContextId: 'context-new' }],
    )

    await expect(completion).resolves.toEqual({ status: 'superseded' })
    expect(result.workspaces['thread-1']?.revealRequest).toBeNull()
  })

  test('closing the Files function keeps file tabs and closing the last file falls back to a function', () => {
    let state = createThreadFileWorkspace({ fileContextId: 'scope-1' }, { kind: 'function', type: 'files' })
    state = openFileTab(state, ref('a.ts'))
    state = { ...state, activeItem: { kind: 'function', type: 'files' } }

    const withoutEntry = { ...state, activeItem: { kind: 'file', tabId: state.openTabs[0]!.id } as const }
    expect(withoutEntry.openTabs).toHaveLength(1)

    const closed = closeFileTab(withoutEntry, withoutEntry.openTabs[0]!.id, ['files', 'browser'])
    expect(closed.openTabs).toEqual([])
    expect(closed.activeItem).toEqual({ kind: 'function', type: 'browser' })
  })

  test('closing the last file falls back only to an open function in fixed order', () => {
    let state = openFileTab(createThreadFileWorkspace({ fileContextId: 'scope-1' }), ref('only.ts'))
    state = closeFileTab(state, state.openTabs[0]!.id, [])
    expect(state.activeItem).toBeNull()

    state = openFileTab(state, ref('again.ts'))
    state = closeFileTab(state, state.openTabs[0]!.id, ['files', 'browser'])
    expect(state.activeItem).toEqual({ kind: 'function', type: 'browser' })
  })

  test('ignores a late image preview scope after its tab has closed', () => {
    let state = openFileTab(createThreadFileWorkspace({ fileContextId: 'scope-1' }), ref('result.png'))
    const tabId = state.openTabs[0]!.id
    state = closeFileTab(state, tabId, ['files'])

    expect(setFilePreviewScope(state, tabId, 'late-token')).toBe(state)
    expect(state.openTabs).toEqual([])
    expect(state.previewScopes).toEqual({})
  })

  test('opens session artifact FileRefs as artifact tabs', () => {
    const state = openFileTab(
      createThreadFileWorkspace({ fileContextId: 'scope-1' }),
      ref('artifacts/report.pdf', 'session', 'scope-1'),
    )

    expect(state.openTabs[0]?.target).toMatchObject({
      kind: 'artifact',
      viewer: 'pdf',
      ref: { relativePath: 'artifacts/report.pdf' },
    })
  })

  test('uses the shortest distinguishing parent path for duplicate basenames', () => {
    const labels = disambiguateFileTabLabels([
      { ...openFileTab(createThreadFileWorkspace({}), ref('src/client/index.ts')).openTabs[0]!, id: 'a' },
      { ...openFileTab(createThreadFileWorkspace({}), ref('test/client/index.ts')).openTabs[0]!, id: 'b' },
      { ...openFileTab(createThreadFileWorkspace({}), ref('README.md')).openTabs[0]!, id: 'c' },
    ])

    expect(labels).toEqual({
      a: 'index.ts — src/client',
      b: 'index.ts — test/client',
      c: 'README.md',
    })
  })

  test('rewrites directory descendants and removes every deleted descendant tab', () => {
    let state = createThreadFileWorkspace({ fileContextId: 'scope-1' })
    state = openFileTab(state, ref('src/a.ts'))
    state = openFileTab(state, ref('src/nested/b.ts'))
    state = openFileTab(state, ref('other.ts'))
    state = rewriteFileRefPrefix(state, ref('src'), ref('lib'))

    expect(state.openTabs.map((tab) => tab.ref?.relativePath)).toEqual(['lib/a.ts', 'lib/nested/b.ts', 'other.ts'])

    state = removeFileRef(state, ref('lib'), true, ['files'])
    expect(state.openTabs.map((tab) => tab.ref?.relativePath)).toEqual(['other.ts'])
  })

  test('thread removal revokes scopes and rebinding preserves only the authorized session scope', () => {
    let keep = createThreadFileWorkspace({ workspaceId: 'workspace-1', fileContextId: 'context-1' })
    keep = openFileTab(keep, ref('kept.md', 'session', 'context-1'))
    keep = openFileTab(keep, ref('drop.md', 'project', 'workspace-1'))
    keep = { ...keep, previewScopes: { first: 'token-1', second: 'token-2' } }

    const removed = createThreadFileWorkspace({ workspaceId: 'workspace-2', fileContextId: 'context-2' })
    const result = reconcileThreadFileWorkspaces(
      { keep, removed },
      [{ id: 'keep', workspaceId: 'workspace-3', fileContextId: 'context-1', openFunctions: ['browser'] }],
    )

    expect(result.workspaces.removed).toBeUndefined()
    expect(result.workspaces.keep!.openTabs.map((tab) => tab.ref?.source)).toEqual(['session'])
    expect(result.workspaces.keep!.activeItem).toEqual({ kind: 'function', type: 'browser' })
    expect(result.workspaces.keep!.directoryCache).toEqual({})
    expect(result.revokedScopeTokens).toEqual(['token-1', 'token-2'])
  })

  test('project rebinding clears project tabs, cache, selection and preview scopes', () => {
    let state = createThreadFileWorkspace({ workspaceId: 'workspace-1', fileContextId: 'context-1', projectBindingKey: 'old-root' })
    const projectRef = ref('src/app.ts', 'project', 'workspace-1')
    state = openFileTab(state, projectRef)
    state = {
      ...state,
      selectedRef: projectRef,
      directoryCache: { project: [] },
      previewScopes: { [state.openTabs[0]!.id]: 'scope-token' },
    }
    const result = reconcileThreadFileWorkspaces({ thread: state }, [{
      id: 'thread', workspaceId: 'workspace-1', fileContextId: 'context-1', projectBindingKey: 'new-root', openFunctions: ['files'],
    }])
    expect(result.workspaces.thread).toMatchObject({
      openTabs: [], selectedRef: null, directoryCache: {}, previewScopes: {},
    })
    expect(result.revokedScopeTokens).toEqual(['scope-token'])
  })

  test('uses the current workspace binding for threads without an explicit workspace', () => {
    expect(getEffectiveThreadFileBindings([
      { id: 'implicit', fileContextId: 'context-1' },
      { id: 'explicit', workspaceId: 'workspace-2' },
    ], 'workspace-1')).toEqual([
      { id: 'implicit', workspaceId: 'workspace-1', fileContextId: 'context-1' },
      { id: 'explicit', workspaceId: 'workspace-2', fileContextId: 'explicit' },
    ])
  })

  test('a fresh process starts with no runtime file state', () => {
    expect(createThreadFileWorkspace({ fileContextId: 'scope-1' })).toMatchObject({
      selectedRef: null,
      openTabs: [],
      expandedKeys: [],
      search: { query: '' },
    })
  })

  test('persists MCP resources as reusable tabs and migrates legacy file tabs', () => {
    const target = {
      kind: 'mcp-resource' as const,
      workspaceSlug: 'demo',
      resource: { serverId: 'docs', serverName: 'Docs', uri: 'docs://guide', name: 'Guide' },
    }
    let state = openFileTab(createThreadFileWorkspace({}), target)
    state = openFileTab(state, target)
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0]?.target).toEqual(target)

    const restored = normalizePersistedRightPanelFileTabs([{
      id: 'legacy',
      ref: ref('artifacts/report.md'),
      navigationRevision: 2,
    }])
    expect(restored[0]).toMatchObject({
      id: 'legacy',
      target: { kind: 'artifact', ref: { relativePath: 'artifacts/report.md' }, viewer: 'markdown' },
    })
  })
})

describe('preview tab 状态转换', () => {
  const binding = { fileContextId: 'ctx-1' }
  const base = () => createThreadFileWorkspace(binding)

  test('previewFileTab 设置预览但不动 activeItem', () => {
    const state = previewFileTab(createThreadFileWorkspace({ fileContextId: 'ctx-1' }, { kind: 'function', type: 'files' }), ref('a.ts'))
    expect(state.previewTab?.target).toEqual({ kind: 'file', ref: ref('a.ts') })
    expect(state.activeItem).toEqual({ kind: 'function', type: 'files' }) // 树常驻：激活态不变
    expect(state.openTabs).toEqual([])
  })

  test('previewFileTab 替换为不同文件（单槽）', () => {
    let state = previewFileTab(base(), ref('a.ts'))
    state = previewFileTab(state, ref('b.ts'))
    expect(next_target(state)).toBe('b.ts')
  })

  test('previewFileTab 同文件重复点击只刷新 navigationRevision', () => {
    let state = previewFileTab(base(), ref('a.ts'))
    const firstRevision = state.previewTab!.navigationRevision
    state = previewFileTab(state, ref('a.ts'))
    expect(state.previewTab!.navigationRevision).toBe(firstRevision + 1)
    expect(state.previewTab?.id).toMatch(/^preview:/)
  })

  test('openFileTab 新建正式 tab 时清空预览槽', () => {
    let state = previewFileTab(base(), ref('a.ts'))
    state = openFileTab(state, ref('b.ts'))
    expect(state.previewTab).toBeNull()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0]!.id).toMatch(/^file:/)
  })

  test('openFileTab 激活既有正式 tab 时也清空预览槽', () => {
    let state = openFileTab(base(), ref('a.ts'))
    state = previewFileTab(state, ref('b.ts'))
    state = openFileTab(state, ref('a.ts'))
    expect(state.previewTab).toBeNull()
    expect(state.openTabs).toHaveLength(1)
    expect(state.activeItem).toEqual({ kind: 'file', tabId: state.openTabs[0]!.id })
  })

  test('pinPreviewFileTab 原地转正并清空预览', () => {
    let state = previewFileTab(base(), ref('a.ts'))
    state = pinPreviewFileTab(state)
    expect(state.previewTab).toBeNull()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0]!.id).toMatch(/^file:/)
    expect(state.activeItem).toEqual({ kind: 'file', tabId: state.openTabs[0]!.id })
  })

  test('pinPreviewFileTab 对已打开文件去重（激活既有 tab）', () => {
    let state = openFileTab(base(), ref('a.ts'))
    const openTabId = state.openTabs[0]!.id
    state = previewFileTab(state, ref('a.ts'))
    state = pinPreviewFileTab(state)
    expect(state.openTabs).toHaveLength(1)
    expect(state.activeItem).toEqual({ kind: 'file', tabId: openTabId })
  })

  test('pinPreviewFileTab 无预览时原样返回', () => {
    const state = base()
    expect(pinPreviewFileTab(state)).toBe(state)
  })

  test('clearPreviewFileTab 清预览且不影响 activeItem', () => {
    let state = openFileTab(base(), ref('a.ts'))
    const before = state.activeItem
    state = previewFileTab(state, ref('b.ts'))
    state = clearPreviewFileTab(state)
    expect(state.previewTab).toBeNull()
    expect(state.activeItem).toEqual(before)
  })

  test('reconcile 换 binding 后清空 previewTab', () => {
    let state = createThreadFileWorkspace({ workspaceId: 'w1', fileContextId: 'ctx-1' })
    state = previewFileTab(state, ref('a.ts'))
    expect(state.previewTab).not.toBeNull()
    const result = reconcileThreadFileWorkspaces({ thread: state }, [{
      id: 'thread', workspaceId: 'w1', fileContextId: 'ctx-2', openFunctions: ['files'],
    }])
    expect(result.workspaces.thread!.previewTab).toBeNull()
  })

  test('clearPreviewFileTab 无预览时原样返回', () => {
    const state = base()
    expect(clearPreviewFileTab(state)).toBe(state)
  })
})

function next_target(state: ReturnType<typeof createThreadFileWorkspace>): string {
  const tab = state.previewTab
  if (!tab || tab.target.kind === 'mcp-resource') return ''
  return tab.target.ref.relativePath
}
