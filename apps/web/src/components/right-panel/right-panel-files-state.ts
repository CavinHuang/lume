import type { FileRef, FileSource, GuardedFileRef } from '@lume/shared'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'
import { RIGHT_PANEL_FUNCTION_ORDER, type RightPanelFunction } from './right-panel-state'

export type RightPanelActiveItem =
  | { kind: 'function'; type: RightPanelFunction }
  | { kind: 'file'; tabId: string }

export type RightPanelFileTab = {
  id: string
  ref: FileRef
  guardedRef?: GuardedFileRef
  lineSelection?: ThreadFileLineSelection
  navigationRevision: number
}

export type RightPanelFileTarget = FileRef | GuardedFileRef

export interface FileTreeRevealRequest {
  requestId: string
  navigationRevision: number
  ref: FileRef
  guardedRef?: GuardedFileRef
}

export type FileSourceLoadState = 'fresh' | 'stale' | 'loading' | 'error'

export interface ThreadFileWorkspace {
  binding: { workspaceId?: string; fileContextId?: string }
  activeItem: RightPanelActiveItem | null
  selectedRef: FileRef | null
  temporaryPreviewRef: FileRef | null
  expandedKeys: string[]
  groupExpanded: Record<FileSource, boolean>
  directoryCache: Record<string, unknown>
  scrollAnchor: string | null
  search: { query: string; includeExcluded?: boolean; includeLegacy?: boolean }
  detailsCollapsed: boolean
  openTabs: RightPanelFileTab[]
  sourceStatus: Record<FileSource, FileSourceLoadState>
  previewScopes: Record<string, string>
  revealRequest: FileTreeRevealRequest | null
}

export interface FileRefIdentityOptions {
  caseInsensitive?: boolean
}

const SOURCES: FileSource[] = ['project', 'session', 'memory', 'legacy']

export function normalizeFileRef(ref: FileRef, options: FileRefIdentityOptions = {}): FileRef {
  const parts: string[] = []
  for (const part of ref.relativePath.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error('FileRef relativePath cannot traverse its scope')
    parts.push(options.caseInsensitive ? part.toLocaleLowerCase('en-US') : part)
  }
  return { ...ref, relativePath: parts.join('/') }
}

export function fileRefKey(ref: FileRef, options: FileRefIdentityOptions = {}): string {
  const normalized = normalizeFileRef(ref, options)
  return `${normalized.source}:${normalized.scopeId}:${normalized.relativePath}`
}

export function createThreadFileWorkspace(
  binding: ThreadFileWorkspace['binding'],
  activeItem: RightPanelActiveItem | null = null,
): ThreadFileWorkspace {
  return {
    binding,
    activeItem,
    selectedRef: null,
    temporaryPreviewRef: null,
    expandedKeys: [],
    groupExpanded: { project: true, session: true, memory: false, legacy: false },
    directoryCache: {},
    scrollAnchor: null,
    search: { query: '' },
    detailsCollapsed: false,
    openTabs: [],
    sourceStatus: { project: 'fresh', session: 'fresh', memory: 'fresh', legacy: 'fresh' },
    previewScopes: {},
    revealRequest: null,
  }
}

export function openFileTab(
  state: ThreadFileWorkspace,
  target: RightPanelFileTarget,
  options: FileRefIdentityOptions & { lineSelection?: ThreadFileLineSelection; navigationRevision?: number } = {},
): ThreadFileWorkspace {
  const guardedRef = isGuardedFileRef(target) ? target : undefined
  const ref = guardedRef?.ref ?? target as FileRef
  const lineSelection = normalizeLineSelection(options.lineSelection)
  const key = fileRefKey(ref, options)
  const existing = state.openTabs.find((tab) => fileRefKey(tab.ref, options) === key)
  if (existing) {
    const navigationRevision = options.navigationRevision ?? existing.navigationRevision + 1
    return {
      ...state,
      openTabs: state.openTabs.map((tab) => tab.id === existing.id ? {
        ...tab,
        ...(guardedRef ? { guardedRef } : {}),
        lineSelection,
        navigationRevision,
      } : tab),
      activeItem: { kind: 'file', tabId: existing.id },
    }
  }

  const normalized = normalizeFileRef(ref)
  const tab: RightPanelFileTab = {
    id: `file:${encodeURIComponent(key)}`,
    ref: normalized,
    ...(guardedRef ? { guardedRef: { ...guardedRef, ref: normalized as GuardedFileRef['ref'] } as GuardedFileRef } : {}),
    lineSelection,
    navigationRevision: options.navigationRevision ?? 1,
  }
  return {
    ...state,
    openTabs: [...state.openTabs, tab],
    activeItem: { kind: 'file', tabId: tab.id },
  }
}

export function normalizeLineSelection(selection?: ThreadFileLineSelection): ThreadFileLineSelection | undefined {
  if (!selection) return undefined
  const start = Math.max(1, Math.trunc(selection.start))
  const end = Math.max(start, Math.trunc(selection.end))
  return { start, end }
}

export function isGuardedFileRef(value: RightPanelFileTarget): value is GuardedFileRef {
  return Boolean(value && typeof value === 'object' && 'guard' in value && 'ref' in value)
}

export function closeFileTab(
  state: ThreadFileWorkspace,
  tabId: string,
  fallbackFunctions: RightPanelFunction[],
): ThreadFileWorkspace {
  const index = state.openTabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return state
  const openTabs = state.openTabs.filter((tab) => tab.id !== tabId)
  const previewScopes = { ...state.previewScopes }
  delete previewScopes[tabId]
  if (state.activeItem?.kind !== 'file' || state.activeItem.tabId !== tabId) {
    return { ...state, openTabs, previewScopes }
  }
  const nearby = openTabs[Math.min(index, openTabs.length - 1)]
  const fallback = RIGHT_PANEL_FUNCTION_ORDER.find((type) => fallbackFunctions.includes(type))
  return {
    ...state,
    openTabs,
    previewScopes,
    activeItem: nearby
      ? { kind: 'file', tabId: nearby.id }
      : fallback
        ? { kind: 'function', type: fallback }
        : null,
  }
}

export function setFilePreviewScope(
  state: ThreadFileWorkspace,
  scopeKey: string,
  token: string | null,
): ThreadFileWorkspace {
  if (token && !scopeKey.startsWith('temporary:') && !state.openTabs.some((tab) => tab.id === scopeKey)) {
    return state
  }
  if (state.previewScopes[scopeKey] === token || (!token && !state.previewScopes[scopeKey])) return state
  const previewScopes = { ...state.previewScopes }
  if (token) previewScopes[scopeKey] = token
  else delete previewScopes[scopeKey]
  return { ...state, previewScopes }
}

function sameScope(left: FileRef, right: FileRef): boolean {
  return left.source === right.source && left.scopeId === right.scopeId
}

function isSameOrDescendant(path: string, prefix: string): boolean {
  return path === prefix || (prefix.length > 0 && path.startsWith(`${prefix}/`))
}

function rewriteRef(ref: FileRef, from: FileRef, to: FileRef): FileRef {
  const normalizedRef = normalizeFileRef(ref)
  const normalizedFrom = normalizeFileRef(from)
  if (!sameScope(normalizedRef, normalizedFrom) || !isSameOrDescendant(normalizedRef.relativePath, normalizedFrom.relativePath)) {
    return ref
  }
  const suffix = normalizedRef.relativePath.slice(normalizedFrom.relativePath.length).replace(/^\//, '')
  const normalizedTo = normalizeFileRef(to)
  return { ...normalizedTo, relativePath: [normalizedTo.relativePath, suffix].filter(Boolean).join('/') }
}

export function rewriteFileRefPrefix(state: ThreadFileWorkspace, from: FileRef, to: FileRef): ThreadFileWorkspace {
  const rewriteNullable = (value: FileRef | null) => value ? rewriteRef(value, from, to) : null
  return {
    ...state,
    selectedRef: rewriteNullable(state.selectedRef),
    temporaryPreviewRef: rewriteNullable(state.temporaryPreviewRef),
    openTabs: state.openTabs.map((tab) => {
      const nextRef = rewriteRef(tab.ref, from, to)
      return nextRef === tab.ref ? tab : { ...tab, ref: nextRef }
    }),
  }
}

export function removeFileRef(
  state: ThreadFileWorkspace,
  target: FileRef,
  recursive: boolean,
  fallbackFunctions: RightPanelFunction[],
): ThreadFileWorkspace {
  const normalizedTarget = normalizeFileRef(target)
  const matches = (ref: FileRef) => {
    const normalized = normalizeFileRef(ref)
    return sameScope(normalized, normalizedTarget)
      && (recursive
        ? isSameOrDescendant(normalized.relativePath, normalizedTarget.relativePath)
        : normalized.relativePath === normalizedTarget.relativePath)
  }
  let next = state
  for (const tab of state.openTabs.filter((item) => matches(item.ref))) {
    next = closeFileTab(next, tab.id, fallbackFunctions)
  }
  return {
    ...next,
    selectedRef: next.selectedRef && matches(next.selectedRef) ? null : next.selectedRef,
    temporaryPreviewRef: next.temporaryPreviewRef && matches(next.temporaryPreviewRef) ? null : next.temporaryPreviewRef,
  }
}

export function disambiguateFileTabLabels(tabs: RightPanelFileTab[]): Record<string, string> {
  const result: Record<string, string> = {}
  const groups = new Map<string, RightPanelFileTab[]>()
  for (const tab of tabs) {
    const name = basename(tab.ref.relativePath)
    groups.set(name, [...(groups.get(name) ?? []), tab])
  }
  for (const [name, group] of groups) {
    if (group.length === 1) {
      result[group[0]!.id] = name
      continue
    }
    const parents = group.map((tab) => parentSegments(tab.ref.relativePath))
    for (let index = 0; index < group.length; index += 1) {
      const own = parents[index]!
      let depth = 1
      while (depth < own.length) {
        const suffix = own.slice(-depth).join('/')
        const unique = parents.every((candidate, other) => other === index || candidate.slice(-depth).join('/') !== suffix)
        if (unique) break
        depth += 1
      }
      const parent = own.slice(-depth).join('/') || group[index]!.ref.source
      result[group[index]!.id] = `${name} — ${parent}`
    }
  }
  return result
}

export function reconcileThreadFileWorkspaces(
  workspaces: Record<string, ThreadFileWorkspace>,
  threads: Array<{ id: string; workspaceId?: string; fileContextId?: string; openFunctions?: RightPanelFunction[] }>,
): { workspaces: Record<string, ThreadFileWorkspace>; revokedScopeTokens: string[] } {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]))
  const next: Record<string, ThreadFileWorkspace> = {}
  const revokedScopeTokens: string[] = []
  for (const [threadId, state] of Object.entries(workspaces)) {
    const thread = threadById.get(threadId)
    if (!thread) {
      if (state.revealRequest) settleFileTreeReveal(state.revealRequest.requestId, { status: 'superseded' })
      revokedScopeTokens.push(...Object.values(state.previewScopes))
      continue
    }
    const rebound = state.binding.workspaceId !== thread.workspaceId || state.binding.fileContextId !== thread.fileContextId
    if (!rebound) {
      next[threadId] = state
      continue
    }
    if (state.revealRequest) settleFileTreeReveal(state.revealRequest.requestId, { status: 'superseded' })
    revokedScopeTokens.push(...Object.values(state.previewScopes))
    const openTabs = state.openTabs.filter((tab) => tab.ref.source === 'session' && tab.ref.scopeId === thread.fileContextId)
    const activeFileTabId = state.activeItem?.kind === 'file' ? state.activeItem.tabId : null
    const fallbackFunction = RIGHT_PANEL_FUNCTION_ORDER.find((type) => thread.openFunctions?.includes(type))
    const activeItem = activeFileTabId && !openTabs.some((tab) => tab.id === activeFileTabId)
      ? fallbackFunction
        ? { kind: 'function' as const, type: fallbackFunction }
        : openTabs.at(-1)
          ? { kind: 'file' as const, tabId: openTabs.at(-1)!.id }
        : null
      : state.activeItem
    next[threadId] = {
      ...state,
      binding: { workspaceId: thread.workspaceId, fileContextId: thread.fileContextId },
      activeItem,
      openTabs,
      selectedRef: state.selectedRef?.source === 'session' && state.selectedRef.scopeId === thread.fileContextId ? state.selectedRef : null,
      temporaryPreviewRef: null,
      directoryCache: {},
      sourceStatus: Object.fromEntries(SOURCES.map((source) => [source, 'stale'])) as ThreadFileWorkspace['sourceStatus'],
      previewScopes: {},
      revealRequest: null,
    }
  }
  return { workspaces: next, revokedScopeTokens }
}

type RevealSettlement = { status: 'opened' | 'superseded' | 'unavailable' }
const revealSettlements = new Map<string, { resolve: (value: RevealSettlement) => void; timeout: ReturnType<typeof setTimeout> }>()

export function createFileTreeRevealRequest(
  target: RightPanelFileTarget,
  navigationRevision: number,
  timeoutMs = 10_000,
): { request: FileTreeRevealRequest; completion: Promise<RevealSettlement> } {
  const requestId = crypto.randomUUID()
  const guardedRef = isGuardedFileRef(target) ? target : undefined
  const ref = guardedRef?.ref ?? target as FileRef
  let resolveCompletion!: (value: RevealSettlement) => void
  const completion = new Promise<RevealSettlement>((resolve) => { resolveCompletion = resolve })
  const timeout = setTimeout(() => settleFileTreeReveal(requestId, { status: 'unavailable' }), timeoutMs)
  revealSettlements.set(requestId, { resolve: resolveCompletion, timeout })
  return { request: { requestId, navigationRevision, ref, ...(guardedRef ? { guardedRef } : {}) }, completion }
}

export function settleFileTreeReveal(requestId: string, result: RevealSettlement): void {
  const pending = revealSettlements.get(requestId)
  if (!pending) return
  revealSettlements.delete(requestId)
  clearTimeout(pending.timeout)
  pending.resolve(result)
}

export function getFileTreeRevealDirectories(target: FileRef): FileRef[] {
  const segments = normalizeFileRef(target).relativePath.split('/').filter(Boolean)
  return Array.from({ length: Math.max(segments.length, 1) }, (_, index) => ({
    ...target,
    relativePath: segments.slice(0, index).join('/'),
  }))
}

export function getEffectiveThreadFileBindings(
  threads: Array<{ id: string; workspaceId?: string; fileContextId?: string }>,
  currentWorkspaceId?: string | null,
): Array<{ id: string; workspaceId?: string; fileContextId: string }> {
  return threads.map((thread) => ({
    id: thread.id,
    workspaceId: thread.workspaceId ?? currentWorkspaceId ?? undefined,
    fileContextId: thread.fileContextId ?? thread.id,
  }))
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function parentSegments(path: string): string[] {
  return path.split('/').filter(Boolean).slice(0, -1)
}
