import type { FileEntry, FileRef, FileSource } from '@lume/shared'
import { fileRefKey } from './right-panel-files-state'
import type { FileSourceLoadState } from './right-panel-files-state'

export interface UnifiedFileTreeState {
  groups: Array<{ source: FileSource; expanded: boolean }>
  expandedKeys: string[]
  selectedKey: string | null
  scrollAnchor: string | null
  searchQuery: string
  searchSnapshot: Pick<UnifiedFileTreeState, 'expandedKeys' | 'selectedKey' | 'scrollAnchor'> | null
  sourceStatus: Record<FileSource, FileSourceLoadState>
}

export function createUnifiedFileTreeState(input: { hasLegacy: boolean }): UnifiedFileTreeState {
  const groups: UnifiedFileTreeState['groups'] = [
    { source: 'project', expanded: true },
    { source: 'session', expanded: true },
    { source: 'memory', expanded: false },
  ]
  if (input.hasLegacy) groups.push({ source: 'legacy', expanded: false })
  return {
    groups,
    expandedKeys: [],
    selectedKey: null,
    scrollAnchor: null,
    searchQuery: '',
    searchSnapshot: null,
    sourceStatus: { project: 'fresh', session: 'fresh', memory: 'fresh', legacy: 'fresh' },
  }
}

export function beginTreeSearch(state: UnifiedFileTreeState, query: string): UnifiedFileTreeState {
  return {
    ...state,
    searchQuery: query,
    searchSnapshot: state.searchSnapshot ?? {
      expandedKeys: state.expandedKeys,
      selectedKey: state.selectedKey,
      scrollAnchor: state.scrollAnchor,
    },
  }
}

export function endTreeSearch(state: UnifiedFileTreeState): UnifiedFileTreeState {
  return {
    ...state,
    ...(state.searchSnapshot ?? {}),
    searchQuery: '',
    searchSnapshot: null,
  }
}

export function markSourceStale(state: UnifiedFileTreeState, source: FileSource): UnifiedFileTreeState {
  return { ...state, sourceStatus: { ...state.sourceStatus, [source]: 'stale' } }
}

export function getFileSourceCapabilities(source: FileSource): {
  preview: true
  open: true
  reveal: true
  copyPath: true
  rename: boolean
  move: boolean
  delete: boolean
  readOnlyReason?: string
} {
  const writable = source === 'session'
  return {
    preview: true,
    open: true,
    reveal: true,
    copyPath: true,
    rename: writable,
    move: writable,
    delete: writable,
    ...(writable ? {} : { readOnlyReason: '该来源为只读' }),
  }
}

export function settleMutation(input: {
  startGeneration: number
  currentGeneration: number
  ok: boolean
}): 'patch' | 'reload' | 'rollback' {
  if (!input.ok) return 'rollback'
  return input.startGeneration === input.currentGeneration ? 'patch' : 'reload'
}

export class SourceMutationQueue {
  private pending = Promise.resolve()

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }
}

export function getUnifiedFileTreeCacheIdentity(
  workspaceSlug?: string,
  fileContextId?: string,
  workspaceProjectPath?: string,
): string {
  return `${workspaceSlug ?? ''}\0${fileContextId ?? ''}\0${workspaceProjectPath ?? ''}`
}

export function getRovingTreeTabStopKey(selectedKey: string | null, visibleKeys: string[]): string | null {
  return selectedKey && visibleKeys.includes(selectedKey) ? selectedKey : visibleKeys[0] ?? null
}

export function getRovingTreeTabIndex(rowKey: string, tabStopKey: string | null): 0 | -1 {
  return rowKey === tabStopKey ? 0 : -1
}

export function shouldCommitTreeRequest(input: {
  requestIdentity: string
  currentIdentity: string
  requestGeneration: number
  currentGeneration: number
}): boolean {
  return input.requestIdentity === input.currentIdentity
    && input.requestGeneration === input.currentGeneration
}

export function invalidateSourceDirectoryCache<T>(cache: Record<string, T>, source: FileSource): Record<string, T> {
  return Object.fromEntries(Object.entries(cache).filter(([key]) => !key.startsWith(`${source}:`)))
}

export function getSourceRefreshRefs(
  cache: Record<string, FileEntry[]>,
  expandedKeys: string[],
  roots: FileRef[],
  source: FileSource,
): FileRef[] {
  const expanded = new Set(expandedKeys)
  const refs = new Map<string, FileRef>()
  for (const root of roots.filter((candidate) => candidate.source === source)) refs.set(fileRefKey(root), root)
  for (const entries of Object.values(cache)) {
    for (const entry of entries) {
      if (!entry.isDirectory || !entry.ref || entry.ref.source !== source) continue
      const key = fileRefKey(entry.ref)
      if (expanded.has(key)) refs.set(key, entry.ref)
    }
  }
  return [...refs.values()].sort((left, right) => {
    const depth = left.relativePath.split('/').filter(Boolean).length - right.relativePath.split('/').filter(Boolean).length
    return depth || left.relativePath.localeCompare(right.relativePath)
  })
}

export function reconcileSourceTreeNavigation(
  navigation: { expandedKeys: string[]; selectedRef: FileRef | null; scrollAnchor: string | null },
  cache: Record<string, FileEntry[]>,
  source: FileSource,
): typeof navigation {
  const existingKeys = new Set(Object.values(cache).flatMap((entries) => entries.flatMap((entry) => entry.ref ? [fileRefKey(entry.ref)] : [])))
  const sourcePrefix = `${source}:`
  return {
    expandedKeys: navigation.expandedKeys.filter((key) => !key.startsWith(sourcePrefix) || existingKeys.has(key)),
    selectedRef: navigation.selectedRef?.source === source && !existingKeys.has(fileRefKey(navigation.selectedRef))
      ? null
      : navigation.selectedRef,
    scrollAnchor: navigation.scrollAnchor?.startsWith(sourcePrefix) && !existingKeys.has(navigation.scrollAnchor)
      ? null
      : navigation.scrollAnchor,
  }
}
