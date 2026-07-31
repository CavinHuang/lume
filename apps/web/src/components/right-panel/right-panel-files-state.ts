import type { FileRef, FileSource, McpResourceSummary } from '@lume/shared'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'
import { RIGHT_PANEL_FUNCTION_ORDER, type RightPanelFunction } from './right-panel-state'

export type RightPanelActiveItem =
  | { kind: 'function'; type: RightPanelFunction }
  | { kind: 'file'; tabId: string }
  | { kind: 'browser'; tabId: string }

export type RightPanelArtifactViewer = 'markdown' | 'image' | 'pdf' | 'video' | 'text' | 'structured' | 'unknown'

export type RightPanelFileTarget =
  | { kind: 'file'; ref: FileRef }
  | { kind: 'artifact'; ref: FileRef; artifactId: string; viewer: RightPanelArtifactViewer; title?: string }
  | { kind: 'mcp-resource'; workspaceSlug: string; resource: McpResourceSummary }

type RightPanelFileTabBase = {
  id: string
  lineSelection?: ThreadFileLineSelection
  navigationRevision: number
}

export type RightPanelFileTab =
  | (RightPanelFileTabBase & {
      target: Extract<RightPanelFileTarget, { kind: 'file' | 'artifact' }>
      ref: FileRef
    })
  | (RightPanelFileTabBase & {
      target: Extract<RightPanelFileTarget, { kind: 'mcp-resource' }>
      ref?: undefined
    })

export interface FileTreeRevealRequest {
  requestId: string
  navigationRevision: number
  ref: FileRef
}

export type FileSourceLoadState = 'fresh' | 'stale' | 'loading' | 'error'

export interface ThreadFileWorkspace {
  binding: { workspaceId?: string; fileContextId?: string; projectBindingKey?: string }
  activeItem: RightPanelActiveItem | null
  selectedRef: FileRef | null
  temporaryPreviewTarget: RightPanelFileTarget | null
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
    temporaryPreviewTarget: null,
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
  input: RightPanelFileTarget | FileRef,
  options: FileRefIdentityOptions & { lineSelection?: ThreadFileLineSelection; navigationRevision?: number } = {},
): ThreadFileWorkspace {
  const target = normalizeRightPanelFileTarget(input)
  const lineSelection = normalizeLineSelection(options.lineSelection)
  const key = rightPanelFileTargetKey(target, options)
  const existing = state.openTabs.find((tab) => rightPanelFileTargetKey(tab.target, options) === key)
  if (existing) {
    const navigationRevision = options.navigationRevision ?? existing.navigationRevision + 1
    return {
      ...state,
      openTabs: state.openTabs.map((tab) => tab.id === existing.id ? {
        ...tab,
        lineSelection,
        navigationRevision,
      } : tab),
      activeItem: { kind: 'file', tabId: existing.id },
    }
  }

  const normalized = normalizeRightPanelFileTarget(target)
  const base = {
    id: `file:${encodeURIComponent(key)}`,
    lineSelection,
    navigationRevision: options.navigationRevision ?? 1,
  }
  const tab: RightPanelFileTab = normalized.kind === 'mcp-resource'
    ? { ...base, target: normalized }
    : { ...base, target: normalized, ref: normalized.ref }
  return {
    ...state,
    openTabs: [...state.openTabs, tab],
    activeItem: { kind: 'file', tabId: tab.id },
  }
}

export function createRightPanelFileTarget(
  ref: FileRef,
): Extract<RightPanelFileTarget, { kind: 'file' | 'artifact' }> {
  const normalized = normalizeFileRef(ref)
  if (normalized.source !== 'session' || !normalized.relativePath.startsWith('artifacts/')) {
    return { kind: 'file', ref: normalized }
  }
  return {
    kind: 'artifact',
    ref: normalized,
    artifactId: fileRefKey(normalized),
    viewer: inferArtifactViewer(normalized.relativePath),
  }
}

export function normalizeRightPanelFileTarget(input: RightPanelFileTarget | FileRef): RightPanelFileTarget {
  if ('source' in input) return createRightPanelFileTarget(input)
  if (input.kind === 'mcp-resource') {
    return {
      kind: 'mcp-resource',
      workspaceSlug: input.workspaceSlug,
      resource: { ...input.resource },
    }
  }
  return { ...input, ref: normalizeFileRef(input.ref) }
}

export function rightPanelFileTargetKey(
  target: RightPanelFileTarget,
  options: FileRefIdentityOptions = {},
): string {
  if (target.kind === 'mcp-resource') {
    return `mcp:${target.workspaceSlug}:${target.resource.serverId}:${target.resource.uri}`
  }
  return `${target.kind}:${fileRefKey(target.ref, options)}`
}

export function rightPanelFileTargetRef(target: RightPanelFileTarget): FileRef | null {
  return target.kind === 'mcp-resource' ? null : target.ref
}

export function rightPanelFileTargetName(target: RightPanelFileTarget): string {
  if (target.kind === 'mcp-resource') return target.resource.name || target.resource.uri
  return target.kind === 'artifact' && target.title ? target.title : basename(target.ref.relativePath)
}

export function normalizePersistedRightPanelFileTabs(value: unknown): RightPanelFileTab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): RightPanelFileTab[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const target = normalizePersistedTarget(record.target) ?? normalizePersistedFileRef(record.ref)
    if (!target) return []
    const id = typeof record.id === 'string' && record.id
      ? record.id
      : `file:${encodeURIComponent(rightPanelFileTargetKey(target))}`
    const lineSelection = record.lineSelection && typeof record.lineSelection === 'object'
      ? normalizeLineSelection(record.lineSelection as ThreadFileLineSelection)
      : undefined
    const navigationRevision = typeof record.navigationRevision === 'number'
      ? Math.max(1, Math.trunc(record.navigationRevision))
      : 1
    const base = { id, lineSelection, navigationRevision }
    return target.kind === 'mcp-resource'
      ? [{ ...base, target }]
      : [{ ...base, target, ref: target.ref }]
  })
}

export function normalizeLineSelection(selection?: ThreadFileLineSelection): ThreadFileLineSelection | undefined {
  if (!selection) return undefined
  const start = Math.max(1, Math.trunc(selection.start))
  const end = Math.max(start, Math.trunc(selection.end))
  return { start, end }
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
    temporaryPreviewTarget: state.temporaryPreviewTarget?.kind === 'mcp-resource'
      ? state.temporaryPreviewTarget
      : state.temporaryPreviewTarget
        ? { ...state.temporaryPreviewTarget, ref: rewriteRef(state.temporaryPreviewTarget.ref, from, to) }
        : null,
    openTabs: state.openTabs.map((tab) => {
      if (tab.target.kind === 'mcp-resource') return tab
      const nextRef = rewriteRef(tab.target.ref, from, to)
      return nextRef === tab.target.ref ? tab : { ...tab, ref: nextRef, target: { ...tab.target, ref: nextRef } }
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
  for (const tab of state.openTabs.filter((item) => item.ref && matches(item.ref))) {
    next = closeFileTab(next, tab.id, fallbackFunctions)
  }
  return {
    ...next,
    selectedRef: next.selectedRef && matches(next.selectedRef) ? null : next.selectedRef,
    temporaryPreviewTarget: next.temporaryPreviewTarget
      && next.temporaryPreviewTarget.kind !== 'mcp-resource'
      && matches(next.temporaryPreviewTarget.ref)
      ? null
      : next.temporaryPreviewTarget,
  }
}

export function disambiguateFileTabLabels(tabs: RightPanelFileTab[]): Record<string, string> {
  const result: Record<string, string> = {}
  const groups = new Map<string, RightPanelFileTab[]>()
  for (const tab of tabs) {
    const name = rightPanelFileTargetName(tab.target)
    groups.set(name, [...(groups.get(name) ?? []), tab])
  }
  for (const [name, group] of groups) {
    if (group.length === 1) {
      result[group[0]!.id] = name
      continue
    }
    const parents = group.map((tab) => tab.target.kind === 'mcp-resource'
      ? [tab.target.resource.serverName]
      : parentSegments(tab.target.ref.relativePath))
    for (let index = 0; index < group.length; index += 1) {
      const own = parents[index]!
      let depth = 1
      while (depth < own.length) {
        const suffix = own.slice(-depth).join('/')
        const unique = parents.every((candidate, other) => other === index || candidate.slice(-depth).join('/') !== suffix)
        if (unique) break
        depth += 1
      }
      const target = group[index]!.target
      const parent = own.slice(-depth).join('/') || (target.kind === 'mcp-resource' ? 'MCP' : target.ref.source)
      result[group[index]!.id] = `${name} — ${parent}`
    }
  }
  return result
}

export function reconcileThreadFileWorkspaces(
  workspaces: Record<string, ThreadFileWorkspace>,
  threads: Array<{ id: string; workspaceId?: string; fileContextId?: string; projectBindingKey?: string; openFunctions?: RightPanelFunction[] }>,
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
    const rebound = state.binding.workspaceId !== thread.workspaceId
      || state.binding.fileContextId !== thread.fileContextId
      || state.binding.projectBindingKey !== thread.projectBindingKey
    if (!rebound) {
      next[threadId] = state
      continue
    }
    if (state.revealRequest) settleFileTreeReveal(state.revealRequest.requestId, { status: 'superseded' })
    revokedScopeTokens.push(...Object.values(state.previewScopes))
    const openTabs = state.openTabs.filter((tab) => (
      tab.target.kind !== 'mcp-resource'
      && tab.target.ref.source === 'session'
      && tab.target.ref.scopeId === thread.fileContextId
    ))
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
      binding: { workspaceId: thread.workspaceId, fileContextId: thread.fileContextId, projectBindingKey: thread.projectBindingKey },
      activeItem,
      openTabs,
      selectedRef: state.selectedRef?.source === 'session' && state.selectedRef.scopeId === thread.fileContextId ? state.selectedRef : null,
      temporaryPreviewTarget: null,
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
  target: FileRef,
  navigationRevision: number,
  timeoutMs = 10_000,
): { request: FileTreeRevealRequest; completion: Promise<RevealSettlement> } {
  const requestId = crypto.randomUUID()
  const ref = normalizeFileRef(target)
  let resolveCompletion!: (value: RevealSettlement) => void
  const completion = new Promise<RevealSettlement>((resolve) => { resolveCompletion = resolve })
  const timeout = setTimeout(() => settleFileTreeReveal(requestId, { status: 'unavailable' }), timeoutMs)
  revealSettlements.set(requestId, { resolve: resolveCompletion, timeout })
  return { request: { requestId, navigationRevision, ref }, completion }
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
  threads: Array<{ id: string; workspaceId?: string; fileContextId?: string; projectBindingKey?: string }>,
  currentWorkspaceId?: string | null,
): Array<{ id: string; workspaceId?: string; fileContextId: string; projectBindingKey?: string }> {
  return threads.map((thread) => ({
    id: thread.id,
    workspaceId: thread.workspaceId ?? currentWorkspaceId ?? undefined,
    fileContextId: thread.fileContextId ?? thread.id,
    projectBindingKey: thread.projectBindingKey,
  }))
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function parentSegments(path: string): string[] {
  return path.split('/').filter(Boolean).slice(0, -1)
}

function inferArtifactViewer(path: string): RightPanelArtifactViewer {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension ?? '')) return 'image'
  if (extension === 'pdf') return 'pdf'
  if (['mp4', 'webm', 'mov', 'm4v'].includes(extension ?? '')) return 'video'
  if (extension === 'json' || extension === 'jsonl') return 'structured'
  if (['txt', 'log', 'csv', 'tsv', 'xml', 'yaml', 'yml'].includes(extension ?? '')) return 'text'
  return 'unknown'
}

function normalizePersistedTarget(value: unknown): RightPanelFileTarget | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'mcp-resource'
    && typeof record.workspaceSlug === 'string'
    && record.resource
    && typeof record.resource === 'object') {
    const resource = record.resource as Record<string, unknown>
    if (typeof resource.serverId !== 'string'
      || typeof resource.serverName !== 'string'
      || typeof resource.uri !== 'string') return null
    return {
      kind: 'mcp-resource',
      workspaceSlug: record.workspaceSlug,
      resource: resource as unknown as McpResourceSummary,
    }
  }
  const ref = normalizePersistedFileRef(record.ref)
  if (!ref) return null
  if (record.kind === 'artifact') {
    return {
      kind: 'artifact',
      ref: ref.ref,
      artifactId: typeof record.artifactId === 'string' ? record.artifactId : fileRefKey(ref.ref),
      viewer: isArtifactViewer(record.viewer) ? record.viewer : inferArtifactViewer(ref.ref.relativePath),
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
    }
  }
  return ref
}

function normalizePersistedFileRef(
  value: unknown,
): Extract<RightPanelFileTarget, { kind: 'file' | 'artifact' }> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!['project', 'session', 'memory', 'legacy'].includes(String(record.source))
    || typeof record.scopeId !== 'string'
    || typeof record.relativePath !== 'string') return null
  try {
    return createRightPanelFileTarget(record as unknown as FileRef)
  } catch {
    return null
  }
}

function isArtifactViewer(value: unknown): value is RightPanelArtifactViewer {
  return ['markdown', 'image', 'pdf', 'video', 'text', 'structured', 'unknown'].includes(String(value))
}
