import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  beginTreeSearch,
  createUnifiedFileTreeState,
  endTreeSearch,
  getFileSourceCapabilities,
  getUnifiedFileTreeCacheIdentity,
  getSourceRefreshRefs,
  getRovingTreeTabIndex,
  getRovingTreeTabStopKey,
  invalidateSourceDirectoryCache,
  reconcileSourceTreeNavigation,
  markSourceStale,
  settleMutation,
  shouldCommitTreeRequest,
} from './unified-file-tree-state'

describe('unified-file-tree-state', () => {
  test('does not feed live scroll anchor writes back into scroll restoration', () => {
    const source = readFileSync(new URL('./UnifiedFileTree.tsx', import.meta.url), 'utf8')

    expect(source).toContain('pendingScrollRestoreRef')
    expect(source).toContain('if (snapshot) pendingScrollRestoreRef.current = snapshot.scrollAnchor')
    expect(source).not.toContain('[query, workspace.scrollAnchor, workspace.expandedKeys]')
  })

  test('toggles folders from the whole row while keeping file double click open', () => {
    const source = readFileSync(new URL('./UnifiedFileTree.tsx', import.meta.url), 'utf8')

    expect(source).toContain('if (entry.isDirectory) {')
    expect(source).toContain('if (event.detail === 1) void props.onToggle(entry.ref!)')
    expect(source).toContain('} else if (event.detail === 2) {')
    expect(source).toContain('props.onOpen(entry.ref!)')
    expect(source).toContain('event.detail !== 2')
    expect(source).toContain("window.addEventListener('mousedown', openPendingTarget, true)")
    expect(source).toContain("window.addEventListener('click', suppressCapturedGesture, true)")
    expect(source).toContain("window.addEventListener('dblclick', suppressCapturedGesture, true)")
    expect(source).not.toContain('entry.isDirectory ? void props.onToggle(entry.ref!) : props.onOpen(entry.ref!)')
  })

  test('tree previews return to the Files workspace while preserving formal tabs', () => {
    const source = readFileSync(new URL('./UnifiedFileTree.tsx', import.meta.url), 'utf8')

    expect(source).toContain("activeItem: { kind: 'function', type: 'files' }")
    expect(source).toContain("openFunctions.includes('files')")
    expect(source).toContain('<DropdownMenuItem onSelect={() => props.onSelect(entry.ref!)}>预览</DropdownMenuItem>')
  })

  test('uses fixed groups, defaults, and hides empty legacy', () => {
    const state = createUnifiedFileTreeState({ hasLegacy: false })
    expect(state.groups.map((group) => group.source)).toEqual(['project', 'session', 'memory'])
    expect(state.groups.map((group) => group.expanded)).toEqual([true, true, false])
  })

  test('restores expansion, selection, and scroll when search exits', () => {
    const initial = {
      ...createUnifiedFileTreeState({ hasLegacy: true }),
      expandedKeys: ['project:', 'project:src'],
      selectedKey: 'project:src/a.ts',
      scrollAnchor: 'project:src',
    }
    const searching = beginTreeSearch(initial, 'readme')
    const restored = endTreeSearch({ ...searching, expandedKeys: [], selectedKey: null, scrollAnchor: null })
    expect(restored).toMatchObject({
      expandedKeys: initial.expandedKeys,
      selectedKey: initial.selectedKey,
      scrollAnchor: initial.scrollAnchor,
      searchQuery: '',
    })
  })

  test('keeps non-session sources read-only', () => {
    expect(getFileSourceCapabilities('session')).toMatchObject({ rename: true, move: true, delete: true })
    for (const source of ['project', 'memory', 'legacy'] as const) {
      expect(getFileSourceCapabilities(source)).toMatchObject({ rename: false, move: false, delete: false })
    }
  })

  test('marks stale without refreshing and reloads after a generation mismatch', () => {
    const initial = createUnifiedFileTreeState({ hasLegacy: true })
    const stale = markSourceStale(initial, 'session')
    expect(stale.sourceStatus.session).toBe('stale')

    expect(settleMutation({ startGeneration: 2, currentGeneration: 2, ok: true })).toBe('patch')
    expect(settleMutation({ startGeneration: 2, currentGeneration: 3, ok: true })).toBe('reload')
    expect(settleMutation({ startGeneration: 2, currentGeneration: 2, ok: false })).toBe('rollback')
  })

  test('switching file tabs rereads previews without changing the shared tree cache identity', () => {
    let treeListCalls = 0
    let previewReadCalls = 0
    let previousTreeIdentity: string | null = null
    const renderFileTab = (relativePath: string) => {
      const treeIdentity = getUnifiedFileTreeCacheIdentity('workspace', 'context-1')
      if (treeIdentity !== previousTreeIdentity) {
        previousTreeIdentity = treeIdentity
        treeListCalls += 1
      }
      if (relativePath) previewReadCalls += 1
    }

    renderFileTab('src/first.ts')
    renderFileTab('src/second.ts')
    expect(treeListCalls).toBe(1)
    expect(previewReadCalls).toBe(2)
  })

  test('changing a workspace project binding invalidates the shared tree cache identity', () => {
    const unbound = getUnifiedFileTreeCacheIdentity('workspace', 'context-1')
    const bound = getUnifiedFileTreeCacheIdentity('workspace', 'context-1', 'D:/projects/demo')
    const relocated = getUnifiedFileTreeCacheIdentity('workspace', 'context-1', 'D:/projects/demo-next')

    expect(bound).not.toBe(unbound)
    expect(relocated).not.toBe(bound)
  })

  test('gives the selected row or first visible fallback the single tree tab stop', () => {
    expect(getRovingTreeTabStopKey(null, ['first', 'second'])).toBe('first')
    expect(getRovingTreeTabStopKey('selected', ['first', 'selected'])).toBe('selected')
    expect(getRovingTreeTabStopKey('collapsed-child', ['first', 'second'])).toBe('first')
    expect(getRovingTreeTabIndex('first', 'first')).toBe(0)
    expect(getRovingTreeTabIndex('second', 'first')).toBe(-1)
  })

  test('rejects list responses from an old tree identity or source generation', () => {
    expect(shouldCommitTreeRequest({ requestIdentity: 'a', currentIdentity: 'a', requestGeneration: 2, currentGeneration: 2 })).toBe(true)
    expect(shouldCommitTreeRequest({ requestIdentity: 'a', currentIdentity: 'b', requestGeneration: 2, currentGeneration: 2 })).toBe(false)
    expect(shouldCommitTreeRequest({ requestIdentity: 'a', currentIdentity: 'a', requestGeneration: 2, currentGeneration: 3 })).toBe(false)
  })

  test('refresh invalidates a source cache and reloads its expanded descendants', () => {
    const projectRoot = { source: 'project' as const, scopeId: 'workspace', relativePath: '' }
    const source = { ...projectRoot, relativePath: 'src' }
    const nested = { ...projectRoot, relativePath: 'src/nested' }
    const collapsed = { ...projectRoot, relativePath: 'other' }
    const sessionRoot = { source: 'session' as const, scopeId: 'context', relativePath: '' }
    const cache = {
      'project:workspace:': [
        { name: 'src', path: 'src', isDirectory: true, ref: source },
        { name: 'other', path: 'other', isDirectory: true, ref: collapsed },
      ],
      'project:workspace:src': [{ name: 'nested', path: 'src/nested', isDirectory: true, ref: nested }],
      'project:workspace:src/nested': [],
      'session:context:': [],
    }

    expect(getSourceRefreshRefs(cache, [
      'project:workspace:src',
      'project:workspace:src/nested',
    ], [projectRoot, sessionRoot], 'project')).toEqual([projectRoot, source, nested])
    expect(invalidateSourceDirectoryCache(cache, 'project')).toEqual({ 'session:context:': [] })

    expect(reconcileSourceTreeNavigation({
      expandedKeys: ['project:workspace:src', 'project:workspace:missing', 'session:context:kept'],
      selectedRef: source,
      scrollAnchor: 'project:workspace:src',
    }, cache, 'project')).toEqual({
      expandedKeys: ['project:workspace:src', 'session:context:kept'],
      selectedRef: source,
      scrollAnchor: 'project:workspace:src',
    })
    expect(reconcileSourceTreeNavigation({
      expandedKeys: [],
      selectedRef: { ...projectRoot, relativePath: 'missing.txt' },
      scrollAnchor: 'project:workspace:missing.txt',
    }, cache, 'project')).toEqual({ expandedKeys: [], selectedRef: null, scrollAnchor: null })
  })
})
