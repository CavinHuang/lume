import { describe, expect, test } from 'bun:test'
import type { FileRef } from '@lume/shared'
import {
  closeFileTab,
  createThreadFileWorkspace,
  disambiguateFileTabLabels,
  fileRefKey,
  getEffectiveThreadFileBindings,
  openFileTab,
  reconcileThreadFileWorkspaces,
  removeFileRef,
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

  test('closing the Files function keeps file tabs and closing the last file falls back to a function', () => {
    let state = createThreadFileWorkspace({ fileContextId: 'scope-1' }, { kind: 'function', type: 'files' })
    state = openFileTab(state, ref('a.ts'))
    state = { ...state, activeItem: { kind: 'function', type: 'files' } }

    const withoutEntry = { ...state, activeItem: { kind: 'file', tabId: state.openTabs[0]!.id } as const }
    expect(withoutEntry.openTabs).toHaveLength(1)

    const closed = closeFileTab(withoutEntry, withoutEntry.openTabs[0]!.id, ['files', 'review'])
    expect(closed.openTabs).toEqual([])
    expect(closed.activeItem).toEqual({ kind: 'function', type: 'review' })
  })

  test('closing the last file falls back only to an open function in fixed order', () => {
    let state = openFileTab(createThreadFileWorkspace({ fileContextId: 'scope-1' }), ref('only.ts'))
    state = closeFileTab(state, state.openTabs[0]!.id, [])
    expect(state.activeItem).toBeNull()

    state = openFileTab(state, ref('again.ts'))
    state = closeFileTab(state, state.openTabs[0]!.id, ['files', 'browser', 'review'])
    expect(state.activeItem).toEqual({ kind: 'function', type: 'review' })
  })

  test('uses the shortest distinguishing parent path for duplicate basenames', () => {
    const labels = disambiguateFileTabLabels([
      { id: 'a', ref: ref('src/client/index.ts') },
      { id: 'b', ref: ref('test/client/index.ts') },
      { id: 'c', ref: ref('README.md') },
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

    expect(state.openTabs.map((tab) => tab.ref.relativePath)).toEqual(['lib/a.ts', 'lib/nested/b.ts', 'other.ts'])

    state = removeFileRef(state, ref('lib'), true, ['files'])
    expect(state.openTabs.map((tab) => tab.ref.relativePath)).toEqual(['other.ts'])
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
    expect(result.workspaces.keep!.openTabs.map((tab) => tab.ref.source)).toEqual(['session'])
    expect(result.workspaces.keep!.activeItem).toEqual({ kind: 'function', type: 'browser' })
    expect(result.workspaces.keep!.directoryCache).toEqual({})
    expect(result.revokedScopeTokens).toEqual(['token-1', 'token-2'])
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
      temporaryPreviewRef: null,
      openTabs: [],
      expandedKeys: [],
      search: { query: '' },
    })
  })
})
