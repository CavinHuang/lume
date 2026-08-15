import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Braces, Check, ChevronRight, ChevronsUp, Folder, MoreHorizontal, RefreshCw, Search, X } from 'lucide-react'
import { AGENT_IPC_CHANNELS, type FileEntry, type FileIndexEntry, type FileRef, type FileSource, type McpResourceSummary } from '@lume/shared'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import {
  isDesktopRuntime,
  openFileRefInSystem,
  revealFileRefInSystem,
  sidecarCall,
  writeClipboardText,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import { canDragFileRef, FILE_REF_DRAG_MIME, serializeFileRefDragData } from '@/components/agent/file-ref-drag'
import {
  createRightPanelFileTarget,
  fileRefKey,
  getFileTreeRevealDirectories,
  previewFileTab,
  removeFileRef,
  rewriteFileRefPrefix,
  rightPanelFileTargetKey,
  settleFileTreeReveal,
  type RightPanelFileTarget,
  type ThreadFileWorkspace,
} from './right-panel-files-state'
import {
  getFileSourceCapabilities,
  getRovingTreeTabIndex,
  getRovingTreeTabStopKey,
  getSourceRefreshRefs,
  getUnifiedFileTreeCacheIdentity,
  invalidateSourceDirectoryCache,
  reconcileSourceTreeNavigation,
  settleMutation,
  shouldCommitTreeRequest,
} from './unified-file-tree-state'
import { SourceMutationQueue } from './unified-file-tree-state'
import type { RightPanelFunction } from './right-panel-state'

const GROUP_META: Record<FileSource, { label: string; empty: string }> = {
  project: { label: '项目文件', empty: '未绑定项目目录' },
  session: { label: '会话文件', empty: '当前会话还没有文件' },
  memory: { label: '记忆', empty: '没有记忆源文件' },
  legacy: { label: '旧版资源', empty: '没有旧版资源' },
}

export function UnifiedFileTree({
  workspace,
  workspaceSlug,
  workspaceProjectPath,
  fileContextId,
  openFunctions,
  onWorkspaceChange,
  onOpenFile,
  preserveDoubleClickTarget = false,
}: {
  workspace: ThreadFileWorkspace
  workspaceSlug?: string
  workspaceProjectPath?: string
  fileContextId?: string
  openFunctions: RightPanelFunction[]
  onWorkspaceChange: (workspace: ThreadFileWorkspace) => void
  onOpenFile: (target: RightPanelFileTarget | FileRef) => void
  preserveDoubleClickTarget?: boolean
}) {
  const treeCacheIdentity = getUnifiedFileTreeCacheIdentity(workspaceSlug, fileContextId, workspaceProjectPath)
  const [cache, setCache] = useState<Record<string, FileEntry[]>>(() => workspace.directoryCache as Record<string, FileEntry[]>)
  const [loadingKeys, setLoadingKeys] = useState<string[]>([])
  const [query, setQuery] = useState(workspace.search.query)
  const [searchResults, setSearchResults] = useState<Record<string, FileEntry[]>>({})
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [editing, setEditing] = useState<FileRef | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleting, setDeleting] = useState<FileEntry | null>(null)
  const [moving, setMoving] = useState<FileEntry | null>(null)
  const [moveTarget, setMoveTarget] = useState('')
  const [mcpResources, setMcpResources] = useState<McpResourceSummary[]>([])
  const mutationQueue = useRef(new SourceMutationQueue()).current
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRestoreRef = useRef(workspace.scrollAnchor)
  const cacheRef = useRef(cache)
  const workspaceRef = useRef(workspace)
  const treeCacheIdentityRef = useRef(treeCacheIdentity)
  const generationRef = useRef<Record<FileSource, number>>({ project: 0, session: 0, memory: 0, legacy: 0 })
  const previousSourceStatusRef = useRef(workspace.sourceStatus)
  const pendingDoubleClickTargetRef = useRef<RightPanelFileTarget | FileRef | null>(null)
  const searchSnapshotRef = useRef<Pick<ThreadFileWorkspace, 'expandedKeys' | 'selectedRef' | 'scrollAnchor'> | null>(null)
  const roots = useMemo(() => buildSourceRoots(workspaceSlug, fileContextId), [treeCacheIdentity])

  useEffect(() => {
    if (!workspaceSlug) {
      setMcpResources([])
      return
    }
    let disposed = false
    void sidecarCall<{ resources: McpResourceSummary[] }>(AGENT_IPC_CHANNELS.LIST_MCP_RESOURCES, { workspaceSlug })
      .then((result) => { if (!disposed) setMcpResources(result.resources) })
      .catch(() => { if (!disposed) setMcpResources([]) })
    return () => { disposed = true }
  }, [workspaceSlug])

  workspaceRef.current = workspace

  useEffect(() => {
    if (!preserveDoubleClickTarget) {
      pendingDoubleClickTargetRef.current = null
      return
    }
    const openPendingTarget = (event: MouseEvent) => {
      const target = pendingDoubleClickTargetRef.current
      pendingDoubleClickTargetRef.current = null
      if (!target || event.button !== 0 || event.detail !== 2) return
      event.preventDefault()
      event.stopPropagation()
      onOpenFile(target)
    }
    window.addEventListener('mousedown', openPendingTarget, true)
    return () => window.removeEventListener('mousedown', openPendingTarget, true)
  }, [onOpenFile, preserveDoubleClickTarget])

  useLayoutEffect(() => {
    if (treeCacheIdentityRef.current === treeCacheIdentity) return
    treeCacheIdentityRef.current = treeCacheIdentity
    for (const source of Object.keys(generationRef.current) as FileSource[]) generationRef.current[source] += 1
    const nextCache = workspace.directoryCache as Record<string, FileEntry[]>
    cacheRef.current = nextCache
    setCache(nextCache)
    setLoadingKeys([])
    setQuery(workspace.search.query)
    setSearchResults({})
    setSearchTruncated(false)
    setEditing(null)
    setRenameValue('')
    setDeleting(null)
    setMoving(null)
    setMoveTarget('')
    searchSnapshotRef.current = null
    pendingScrollRestoreRef.current = workspace.scrollAnchor
    previousSourceStatusRef.current = workspace.sourceStatus
  }, [treeCacheIdentity])

  useLayoutEffect(() => {
    const nextCache = workspace.directoryCache as Record<string, FileEntry[]>
    if (nextCache === cacheRef.current) return
    cacheRef.current = nextCache
    setCache(nextCache)
  }, [treeCacheIdentity, workspace.directoryCache])

  const commitWorkspace = useCallback((next: ThreadFileWorkspace) => {
    workspaceRef.current = next
    onWorkspaceChange(next)
  }, [onWorkspaceChange])

  const commitCache = useCallback((next: Record<string, FileEntry[]>) => {
    cacheRef.current = next
    setCache(next)
    commitWorkspace({ ...workspaceRef.current, directoryCache: next })
  }, [commitWorkspace])

  const load = useCallback(async (ref: FileRef, force = false, bumpGeneration = force, updateStatus = true): Promise<FileEntry[] | null> => {
    const key = fileRefKey(ref)
    if (!force && cacheRef.current[key]) return cacheRef.current[key]
    if (bumpGeneration) generationRef.current[ref.source] += 1
    const requestIdentity = treeCacheIdentityRef.current
    const requestGeneration = generationRef.current[ref.source]
    setLoadingKeys((keys) => [...new Set([...keys, key])])
    try {
      const entries = await sidecarCall<FileEntry[]>(AGENT_IPC_CHANNELS.LIST_FILE_REF_DIRECTORY, { ref })
      if (!shouldCommitTreeRequest({
        requestIdentity,
        currentIdentity: treeCacheIdentityRef.current,
        requestGeneration,
        currentGeneration: generationRef.current[ref.source],
      })) return null
      const next = { ...cacheRef.current, [key]: entries }
      commitCache(next)
      if (force && updateStatus) {
        commitWorkspace({
          ...workspaceRef.current,
          sourceStatus: { ...workspaceRef.current.sourceStatus, [ref.source]: 'fresh' },
        })
      }
      return entries
    } catch {
      if (!shouldCommitTreeRequest({
        requestIdentity,
        currentIdentity: treeCacheIdentityRef.current,
        requestGeneration,
        currentGeneration: generationRef.current[ref.source],
      })) return null
      if (!updateStatus) return null
      commitWorkspace({
        ...workspaceRef.current,
        sourceStatus: { ...workspaceRef.current.sourceStatus, [ref.source]: 'error' },
      })
      return null
    } finally {
      if (treeCacheIdentityRef.current === requestIdentity) {
        setLoadingKeys((keys) => keys.filter((item) => item !== key))
      }
    }
  }, [commitCache, commitWorkspace])

  useEffect(() => {
    const projectRoot = roots.find((root) => root.source === 'project')
    if (projectRoot) {
      const nextCache = invalidateSourceDirectoryCache(cacheRef.current, 'project')
      cacheRef.current = nextCache
      setCache(nextCache)
    }
    for (const root of roots) void load(root, root.source === 'project')
  }, [roots])

  useEffect(() => {
    const request = workspace.revealRequest
    if (!request) return
    let disposed = false
    const requestIdentity = treeCacheIdentityRef.current
    const target = request.ref

    const isCurrent = () => !disposed
      && treeCacheIdentityRef.current === requestIdentity
      && workspaceRef.current.revealRequest?.requestId === request.requestId

    void (async () => {
      try {
        const segments = target.relativePath.split('/').filter(Boolean)
        const directoriesToLoad = getFileTreeRevealDirectories(target)
        let nextCache = cacheRef.current
        for (const directoryRef of directoriesToLoad) {
          const entries = await sidecarCall<FileEntry[]>(AGENT_IPC_CHANNELS.LIST_FILE_REF_DIRECTORY, { ref: directoryRef })
          if (!isCurrent()) {
            settleFileTreeReveal(request.requestId, { status: 'superseded' })
            return
          }
          nextCache = { ...nextCache, [fileRefKey(directoryRef)]: entries }
        }

        const ancestorKeys = segments.slice(0, -1).map((_, index) => fileRefKey({
          ...target,
          relativePath: segments.slice(0, index + 1).join('/'),
        }))
        const targetKey = fileRefKey(target)
        cacheRef.current = nextCache
        setCache(nextCache)
        commitWorkspace({
          ...workspaceRef.current,
          selectedRef: target,
          expandedKeys: [...new Set([...workspaceRef.current.expandedKeys, ...ancestorKeys])],
          directoryCache: nextCache,
          scrollAnchor: targetKey,
        })
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
        const row = Array.from(scrollContainerRef.current?.querySelectorAll<HTMLElement>('[data-file-ref-key]') ?? [])
          .find((element) => element.dataset.fileRefKey === targetKey)
        row?.scrollIntoView({ block: 'nearest' })
        settleFileTreeReveal(request.requestId, { status: 'opened' })
        if (workspaceRef.current.revealRequest?.requestId === request.requestId) {
          commitWorkspace({ ...workspaceRef.current, revealRequest: null })
        }
      } catch {
        settleFileTreeReveal(request.requestId, isCurrent() ? { status: 'unavailable' } : { status: 'superseded' })
      }
    })()

    return () => {
      disposed = true
      settleFileTreeReveal(request.requestId, { status: 'superseded' })
    }
  }, [workspace.revealRequest?.requestId, treeCacheIdentity, commitWorkspace])

  useEffect(() => {
    for (const source of Object.keys(workspace.sourceStatus) as FileSource[]) {
      if (workspace.sourceStatus[source] === 'stale' && previousSourceStatusRef.current[source] !== 'stale') {
        generationRef.current[source] += 1
      }
    }
    previousSourceStatusRef.current = workspace.sourceStatus
  }, [workspace.sourceStatus])

  useEffect(() => {
    const anchor = pendingScrollRestoreRef.current
    if (query.trim() || !anchor) return
    const frame = requestAnimationFrame(() => {
      const row = Array.from(scrollContainerRef.current?.querySelectorAll<HTMLElement>('[data-tree-row]') ?? [])
        .find((candidate) => candidate.dataset.fileRefKey === anchor)
      if (!row) return
      pendingScrollRestoreRef.current = null
      row.scrollIntoView({ block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [cache, query, treeCacheIdentity, workspace.expandedKeys])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      const snapshot = searchSnapshotRef.current
      searchSnapshotRef.current = null
      if (snapshot) pendingScrollRestoreRef.current = snapshot.scrollAnchor
      commitWorkspace({
        ...workspaceRef.current,
        ...(snapshot ?? {}),
        search: { ...workspaceRef.current.search, query },
      })
      setSearchResults({})
      setSearchTruncated(false)
      return
    }
    searchSnapshotRef.current ??= {
      expandedKeys: workspaceRef.current.expandedKeys,
      selectedRef: workspaceRef.current.selectedRef,
      scrollAnchor: workspaceRef.current.scrollAnchor,
    }
    commitWorkspace({ ...workspaceRef.current, search: { ...workspaceRef.current.search, query } })
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void Promise.all(roots
        .filter((root) => root.source !== 'legacy' || workspace.search.includeLegacy)
        .map(async (root) => {
          const result = await sidecarCall<{ entries: FileIndexEntry[]; truncated?: boolean }>(
            AGENT_IPC_CHANNELS.SEARCH_FILE_REFS,
            { ref: root, query: trimmed, limit: 200, includeExcluded: workspace.search.includeExcluded },
          )
          return [root.source, {
            ...result,
            entries: result.entries.map((entry): FileEntry => ({ ...entry, isDirectory: entry.type === 'dir' })),
          }] as const
        }))
        .then((results) => {
          if (controller.signal.aborted) return
          const grouped = results.reduce<Record<string, FileEntry[]>>((next, [source, result]) => {
            next[source] = [...(next[source] ?? []), ...result.entries]
            return next
          }, {})
          const combinedTruncated = Object.values(grouped).some((entries) => entries.length > 200)
          for (const source of Object.keys(grouped)) grouped[source] = grouped[source]!.slice(0, 200)
          setSearchResults(grouped)
          setSearchTruncated(combinedTruncated || results.some(([, result]) => result.truncated))
        })
        .catch(() => undefined)
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [commitWorkspace, query, roots, workspace.search.includeExcluded, workspace.search.includeLegacy])

  const select = (ref: FileRef) => {
    const entry = findCachedEntry(cacheRef.current, ref)
    const next = entry?.isDirectory
      ? { ...workspaceRef.current, selectedRef: ref }
      : previewFileTab({ ...workspaceRef.current, selectedRef: ref }, ref)
    commitWorkspace(!entry?.isDirectory && openFunctions.includes('files')
      ? { ...next, activeItem: { kind: 'function', type: 'files' } }
      : next)
  }
  const toggle = async (ref: FileRef) => {
    const key = fileRefKey(ref)
    const next = new Set(workspace.expandedKeys)
    if (next.has(key)) next.delete(key)
    else { next.add(key); await load(ref) }
    commitWorkspace({ ...workspaceRef.current, expandedKeys: [...next] })
  }

  const mutateRename = (entry: FileEntry) => mutationQueue.enqueue(async () => {
    if (!entry.ref || !renameValue.trim()) return
    const startIdentity = treeCacheIdentityRef.current
    const startGeneration = generationRef.current[entry.ref.source]
    try {
      const result = await sidecarCall<{ ref: FileRef }>(AGENT_IPC_CHANNELS.RENAME_FILE_REF, { ref: entry.ref, newName: renameValue })
      if (treeCacheIdentityRef.current !== startIdentity) return
      const rewritten = rewriteFileRefPrefix(workspaceRef.current, entry.ref, result.ref)
      if (settleMutation({ startGeneration, currentGeneration: generationRef.current[entry.ref.source], ok: true }) === 'patch') {
        const nextCache = patchRenamedCache(cacheRef.current, entry, result.ref)
        cacheRef.current = nextCache
        setCache(nextCache)
        commitWorkspace({ ...rewritten, directoryCache: nextCache })
      } else {
        commitWorkspace(rewritten)
        await load({ ...entry.ref, relativePath: parentPath(entry.ref.relativePath) }, true)
      }
      setEditing(null)
    } catch (error) {
      if (treeCacheIdentityRef.current !== startIdentity) return
      toast.error(error instanceof Error ? error.message : '重命名失败')
    }
  })
  const mutateDelete = (entry: FileEntry) => mutationQueue.enqueue(async () => {
    if (!entry.ref) return
    const startIdentity = treeCacheIdentityRef.current
    const startGeneration = generationRef.current[entry.ref.source]
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.DELETE_FILE_REF, { ref: entry.ref })
      if (treeCacheIdentityRef.current !== startIdentity) return
      const removed = removeFileRef(workspaceRef.current, entry.ref, entry.isDirectory, openFunctions)
      if (settleMutation({ startGeneration, currentGeneration: generationRef.current[entry.ref.source], ok: true }) === 'patch') {
        const nextCache = patchDeletedCache(cacheRef.current, entry.ref, entry.isDirectory)
        cacheRef.current = nextCache
        setCache(nextCache)
        commitWorkspace({ ...removed, directoryCache: nextCache })
      } else {
        commitWorkspace(removed)
        await load({ ...entry.ref, relativePath: parentPath(entry.ref.relativePath) }, true)
      }
    } catch (error) {
      if (treeCacheIdentityRef.current !== startIdentity) return
      toast.error(error instanceof Error ? error.message : '删除失败')
    }
  })
  const mutateMove = (entry: FileEntry) => mutationQueue.enqueue(async () => {
    if (!entry.ref) return
    const startIdentity = treeCacheIdentityRef.current
    const startGeneration = generationRef.current[entry.ref.source]
    try {
      const targetDirectory = { ...entry.ref, relativePath: moveTarget }
      const result = await sidecarCall<{ ref: FileRef }>(AGENT_IPC_CHANNELS.MOVE_FILE_REF, { ref: entry.ref, targetDirectory })
      if (treeCacheIdentityRef.current !== startIdentity) return
      const rewritten = rewriteFileRefPrefix(workspaceRef.current, entry.ref, result.ref)
      if (settleMutation({ startGeneration, currentGeneration: generationRef.current[entry.ref.source], ok: true }) === 'patch') {
        const nextCache = patchMovedCache(cacheRef.current, entry, result.ref, targetDirectory)
        cacheRef.current = nextCache
        setCache(nextCache)
        commitWorkspace({ ...rewritten, directoryCache: nextCache })
      } else {
        commitWorkspace(rewritten)
        await load({ ...entry.ref, relativePath: parentPath(entry.ref.relativePath) }, true)
        await load(targetDirectory, true)
      }
      setMoving(null)
    } catch (error) {
      if (treeCacheIdentityRef.current !== startIdentity) return
      toast.error(error instanceof Error ? error.message : '移动失败')
    }
  })
  const exportLegacy = async (entry: FileEntry) => {
    if (!entry.ref || entry.ref.source !== 'legacy') return
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.EXPORT_LEGACY_RESOURCE_TO_PROJECT, {
        workspaceSlug: entry.ref.scopeId,
        path: entry.ref.relativePath,
        conflict: 'error',
      })
      commitWorkspace({ ...workspaceRef.current, sourceStatus: { ...workspaceRef.current.sourceStatus, project: 'stale' } })
      toast.success('已导出到项目；项目文件已标记为有更新')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    }
  }
  const copyAbsolutePath = async (ref: FileRef) => {
    const resolved = await sidecarCall<{ path: string }>(AGENT_IPC_CHANNELS.RESOLVE_FILE_REF, { ref })
    await writeClipboardText(resolved.path)
  }
  const refreshSource = async (source: FileSource) => {
    const requestIdentity = treeCacheIdentityRef.current
    generationRef.current[source] += 1
    const requestGeneration = generationRef.current[source]
    const refs = getSourceRefreshRefs(cacheRef.current, workspaceRef.current.expandedKeys, roots, source)
    commitCache(invalidateSourceDirectoryCache(cacheRef.current, source))
    const results = await Promise.all(refs.map((ref) => load(ref, true, false, false)))
    if (!shouldCommitTreeRequest({
      requestIdentity,
      currentIdentity: treeCacheIdentityRef.current,
      requestGeneration,
      currentGeneration: generationRef.current[source],
    })) return
    const navigation = reconcileSourceTreeNavigation(workspaceRef.current, cacheRef.current, source)
    commitWorkspace({
      ...workspaceRef.current,
      ...navigation,
      sourceStatus: { ...workspaceRef.current.sourceStatus, [source]: results.every(Boolean) ? 'fresh' : 'error' },
    })
  }

  const rootFor = (source: FileSource): FileRef => roots.find((candidate) => candidate.source === source)
    ?? { source, scopeId: '', relativePath: '' }
  const hasLegacy = roots
    .filter((candidate) => candidate.source === 'legacy')
    .some((candidate) => (cache[fileRefKey(candidate)]?.length ?? 0) > 0)
  const visibleGroups = [rootFor('project'), rootFor('session'), rootFor('memory'), ...(hasLegacy ? [rootFor('legacy')] : [])]
  const visibleRootEntries = visibleGroups
    .filter((root) => workspace.groupExpanded[root.source])
    .flatMap((root) => query.trim()
      ? searchResults[root.source] ?? []
      : roots.filter((candidate) => candidate.source === root.source).flatMap((candidate) => cache[fileRefKey(candidate)] ?? []))
  const visibleEntryKeys = collectVisibleEntryKeys(visibleRootEntries, cache, new Set(workspace.expandedKeys))
  const treeTabStopKey = getRovingTreeTabStopKey(
    workspace.selectedRef ? fileRefKey(workspace.selectedRef) : null,
    visibleEntryKeys,
  )
  const renderEntry = (entry: FileEntry, depth = 0) => (
    <TreeEntryRow
      key={entry.ref ? fileRefKey(entry.ref) : entry.path}
      entry={entry}
      depth={depth}
      cache={cache}
      expanded={new Set(workspace.expandedKeys)}
      selectedRef={workspace.selectedRef}
      treeTabStopKey={treeTabStopKey}
      loadingKeys={loadingKeys}
      editing={editing}
      renameValue={renameValue}
      onRenameValue={setRenameValue}
      onCommitRename={mutateRename}
      onSelect={select}
      onToggle={toggle}
      onOpen={(ref) => onOpenFile(createRightPanelFileTarget(ref))}
      onArmDoubleClick={preserveDoubleClickTarget
        ? (ref) => { pendingDoubleClickTargetRef.current = ref }
        : undefined}
      onEdit={(next) => { setEditing(next.ref ?? null); setRenameValue(next.name) }}
      onMove={(next) => { setMoving(next); setMoveTarget(parentPath(next.ref?.relativePath ?? '')) }}
      onDelete={setDeleting}
      onExportLegacy={exportLegacy}
      onCopyAbsolutePath={copyAbsolutePath}
      showPath={Boolean(query.trim())}
    />
  )
  return (
    <div className="flex h-full min-h-0 flex-col" role="tree" aria-label="会话文件资源">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-border/70 px-2">
          <Search size={13} className="text-foreground/45" />
          <Input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件" className="h-6 border-0 px-1 text-[12px] shadow-none focus-visible:ring-0" />
          {query && <Button variant="ghost" size="icon-sm" className="size-5" onClick={() => setQuery('')}><X size={11} /></Button>}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => refreshSource(workspace.selectedRef?.source ?? 'project')} title="刷新当前来源"><RefreshCw size={13} /></Button>
        <Button variant="ghost" size="icon-sm" onClick={() => commitWorkspace({ ...workspaceRef.current, expandedKeys: [] })} title="折叠全部目录"><ChevronsUp size={13} /></Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" title="搜索范围" />}><MoreHorizontal size={13} /></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => [...new Set(roots.map((root) => root.source))].forEach((source) => void refreshSource(source))}>
              <Check size={12} className="opacity-0" aria-hidden />刷新全部来源
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => commitWorkspace({ ...workspaceRef.current, search: { ...workspaceRef.current.search, includeExcluded: !workspaceRef.current.search.includeExcluded } })}>
              <Check size={12} className={cn(!workspace.search.includeExcluded && 'opacity-0')} />包含高噪声目录
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => commitWorkspace({ ...workspaceRef.current, search: { ...workspaceRef.current.search, includeLegacy: !workspaceRef.current.search.includeLegacy } })}>
              <Check size={12} className={cn(!workspace.search.includeLegacy && 'opacity-0')} />搜索旧版资源
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {searchTruncated && <div className="border-b px-2 py-1 text-[11px] text-amber-600">扫描达到预算，当前结果不是精确总数。</div>}
      <div ref={scrollContainerRef} className="file-tree-scrollbar min-h-0 flex-1 overflow-auto py-1" onScroll={(event) => {
        if (query.trim()) return
        const element = event.currentTarget
        const row = Array.from(element.querySelectorAll<HTMLElement>('[data-tree-row]'))
          .find((candidate) => candidate.offsetTop + candidate.offsetHeight > element.scrollTop)
        const anchor = row?.dataset.fileRefKey ?? null
        if (anchor !== workspaceRef.current.scrollAnchor) commitWorkspace({ ...workspaceRef.current, scrollAnchor: anchor })
      }} onKeyDown={(event) => handleTreeKeyDown(event, {
        onOpen: (ref) => onOpenFile(createRightPanelFileTarget(ref)),
        onSelect: select,
        onToggle: toggle,
        onEdit: (ref) => {
          const entry = findCachedEntry(cache, ref)
          if (entry && getFileSourceCapabilities(ref.source).rename) { setEditing(ref); setRenameValue(entry.name) }
        },
        onDelete: (ref) => {
          const entry = findCachedEntry(cache, ref)
          if (entry && getFileSourceCapabilities(ref.source).delete) setDeleting(entry)
        },
        onFocusSearch: () => searchInputRef.current?.focus(),
        onEscape: () => setEditing(null),
      })}>
        {visibleGroups.map((root) => {
          const groupKey = `${root.source}:group`
          const groupExpanded = workspace.groupExpanded[root.source]
          const sourceRoots = roots.filter((candidate) => candidate.source === root.source)
          const entries = query.trim()
            ? searchResults[root.source] ?? []
            : sourceRoots.flatMap((candidate) => cache[fileRefKey(candidate)] ?? [])
          const emptyLabel = root.source === 'project'
            ? sourceRoots.length === 0
              ? '未绑定项目目录'
              : workspace.sourceStatus.project === 'error'
                ? '项目目录读取失败，请刷新重试'
                : '项目目录为空'
            : GROUP_META[root.source].empty
          return (
            <div key={root.source}>
              <Button
                variant="ghost"
                className="h-[30px] w-full justify-start gap-1.5 rounded-none px-2 text-[12px] font-medium"
                onClick={() => commitWorkspace({ ...workspaceRef.current, groupExpanded: { ...workspaceRef.current.groupExpanded, [root.source]: !groupExpanded } })}
              >
                <ChevronRight size={13} className={cn('transition-transform', groupExpanded && 'rotate-90')} />
                {GROUP_META[root.source].label}
                {root.source !== 'project' && <span className="text-foreground/38">{entries.length}</span>}
                {workspace.sourceStatus[root.source] === 'stale' && <span className="ml-auto text-[10px] text-amber-600">有更新</span>}
              </Button>
              {groupExpanded && (
                entries.length > 0
                  ? root.source === 'memory' && !query.trim()
                    ? sourceRoots.map((sourceRoot) => (
                      <div key={fileRefKey(sourceRoot)}>
                        <div className="h-7 truncate px-7 py-1 text-[11px] font-medium text-foreground/50">
                          {sourceRoot.scopeId === 'global' ? '全局记忆' : '工作区记忆'}
                        </div>
                        {(cache[fileRefKey(sourceRoot)] ?? []).map((entry) => renderEntry(entry, 1))}
                      </div>
                    ))
                    : entries.map((entry) => renderEntry(entry))
                  : <div className="px-7 py-2 text-[11px] text-foreground/38">{loadingKeys.includes(fileRefKey(root)) ? '加载中…' : emptyLabel}</div>
              )}
              <span className="sr-only">{groupKey}</span>
            </div>
          )
        })}
        {workspaceSlug && mcpResources.length > 0 && (
          <div>
            <div className="flex h-[30px] items-center gap-1.5 px-2 text-[12px] font-medium">
              <ChevronRight size={13} className="rotate-90" />
              MCP 资源
              <span className="text-foreground/38">{mcpResources.length}</span>
            </div>
            {mcpResources
              .filter((resource) => !query.trim()
                || `${resource.name ?? ''} ${resource.uri} ${resource.serverName}`.toLowerCase().includes(query.trim().toLowerCase()))
              .map((resource) => {
                const target = { kind: 'mcp-resource' as const, workspaceSlug, resource }
                const selected = workspace.previewTab
                  ? rightPanelFileTargetKey(workspace.previewTab.target) === rightPanelFileTargetKey(target)
                  : false
                return (
                  <Button
                  key={`${resource.serverId}:${resource.uri}`}
                  variant="ghost"
                  className={cn('h-7 w-full justify-start gap-1.5 rounded-none px-5 text-[12px]', selected && 'bg-primary/10 text-primary')}
                  title={`${resource.serverName} · ${resource.uri}`}
                  onClick={(event) => {
                    const preview = previewFileTab({ ...workspaceRef.current, selectedRef: null }, target)
                    commitWorkspace(openFunctions.includes('files')
                      ? { ...preview, activeItem: { kind: 'function', type: 'files' } }
                      : preview)
                    if (event.detail === 1 && preserveDoubleClickTarget) pendingDoubleClickTargetRef.current = target
                  }}
                  onDoubleClick={() => onOpenFile(target)}
                >
                  <Braces size={13} className="shrink-0 text-foreground/45" />
                  <span className="min-w-0 truncate">{resource.name || resource.uri}</span>
                  </Button>
                )
              })}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => { if (!open) setDeleting(null) }}
        title={deleting?.isDirectory ? '递归删除目录？' : '删除文件？'}
        description={deleting?.isDirectory ? '目录及其全部内容将被删除，所有后代文件 Tab 会关闭。' : (deleting?.name ?? '')}
        destructive
        confirmLabel="删除"
        onConfirm={() => { if (deleting) void mutateDelete(deleting); setDeleting(null) }}
      />
      <Dialog open={Boolean(moving)} onOpenChange={(open) => { if (!open) setMoving(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>移动到目录</DialogTitle><DialogDescription>选择已加载目录；选择目录时会按需加载其子目录。</DialogDescription></DialogHeader>
          <div className="max-h-72 overflow-auto rounded-md border border-border/70 p-1" role="listbox" aria-label="目标目录">
            {fileContextId && [{ source: 'session' as const, scopeId: fileContextId, relativePath: '' }, ...collectLoadedDirectories(cache, fileContextId)].map((ref) => (
              <Button
                key={fileRefKey(ref)}
                variant="ghost"
                className="h-8 w-full justify-start gap-2 px-2 text-[12px]"
                role="option"
                aria-selected={moveTarget === ref.relativePath}
                onClick={() => { setMoveTarget(ref.relativePath); void load(ref) }}
              >
                <Check size={12} className={cn(moveTarget !== ref.relativePath && 'opacity-0')} />
                <Folder size={13} />{ref.relativePath || '会话根目录'}
              </Button>
            ))}
          </div>
          <DialogFooter showCloseButton><Button onClick={() => moving && void mutateMove(moving)}>移动</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TreeEntryRow(props: {
  entry: FileEntry; depth: number; cache: Record<string, FileEntry[]>; expanded: Set<string>
  selectedRef: FileRef | null; treeTabStopKey: string | null; loadingKeys: string[]; editing: FileRef | null; renameValue: string
  onRenameValue: (value: string) => void; onCommitRename: (entry: FileEntry) => Promise<void>
  onSelect: (ref: FileRef) => void; onToggle: (ref: FileRef) => Promise<void>; onOpen: (ref: FileRef) => void
  onArmDoubleClick?: (ref: FileRef) => void
  onEdit: (entry: FileEntry) => void; onMove: (entry: FileEntry) => void; onDelete: (entry: FileEntry) => void
  onExportLegacy: (entry: FileEntry) => Promise<void>; onCopyAbsolutePath: (ref: FileRef) => Promise<void>; showPath: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { entry } = props
  if (!entry.ref) return null
  const key = fileRefKey(entry.ref)
  const open = props.expanded.has(key)
  const selected = props.selectedRef ? fileRefKey(props.selectedRef) === key : false
  const capabilities = getFileSourceCapabilities(entry.ref.source)
  const editing = props.editing ? fileRefKey(props.editing) === key : false
  return (
    <div>
      <div
        data-tree-row
        data-file-ref={JSON.stringify(entry.ref)}
        data-file-ref-key={key}
        data-parent-ref-key={fileRefKey({ ...entry.ref, relativePath: parentPath(entry.ref.relativePath) })}
        tabIndex={getRovingTreeTabIndex(key, props.treeTabStopKey)}
        role="treeitem"
        aria-expanded={entry.isDirectory ? open : undefined}
        draggable={!entry.isDirectory && canDragFileRef(entry.ref)}
        className={cn('group flex h-7 items-center gap-1 pr-1 text-[12px] outline-none hover:bg-foreground/[0.05] focus-visible:ring-1 focus-visible:ring-inset', !entry.isDirectory && canDragFileRef(entry.ref) && 'cursor-grab active:cursor-grabbing', selected && 'bg-primary/10 text-primary')}
        style={{ paddingLeft: 6 + props.depth * 12 }}
        onDragStart={(event) => {
          if (entry.isDirectory || !canDragFileRef(entry.ref!)) return
          event.dataTransfer.effectAllowed = 'copy'
          event.dataTransfer.setData(FILE_REF_DRAG_MIME, serializeFileRefDragData(entry.ref!))
          event.dataTransfer.setData('text/plain', `${entry.ref!.source}/${entry.ref!.relativePath}`)
        }}
        onClick={(event) => {
          event.currentTarget.focus()
          props.onSelect(entry.ref!)
          if (entry.isDirectory) {
            if (event.detail === 1) void props.onToggle(entry.ref!)
          } else if (event.detail === 2) {
            props.onOpen(entry.ref!)
          } else if (event.detail === 1) {
            props.onArmDoubleClick?.(entry.ref!)
          }
        }}
        onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true) }}
      >
        <Button variant="ghost" size="icon-sm" className="size-5 shrink-0" onClick={(event) => { event.stopPropagation(); if (entry.isDirectory) void props.onToggle(entry.ref!) }}>
          {entry.isDirectory ? <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} /> : <span className="w-3" />}
        </Button>
        {entry.isDirectory ? <Folder size={14} className="shrink-0 text-foreground/45" /> : <FileTypeIcon filename={entry.name} size={14} />}
        {editing ? (
          <Input
            autoFocus
            value={props.renameValue}
            onChange={(event) => props.onRenameValue(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === 'Enter') void props.onCommitRename(entry) }}
            className="h-6 min-w-0 flex-1 px-1 text-[12px]"
          />
        ) : <span className="min-w-0 flex-1 truncate">{entry.name}{props.showPath && <span className="ml-2 text-[10px] text-foreground/38">{entry.ref.relativePath}</span>}</span>}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className={cn('size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100', menuOpen && 'opacity-100')} />}><MoreHorizontal size={12} /></DropdownMenuTrigger>
          <DropdownMenuContent>
            {!entry.isDirectory && <DropdownMenuItem onSelect={() => props.onOpen(entry.ref!)}>预览</DropdownMenuItem>}
            <DropdownMenuItem disabled={!isDesktopRuntime()} onSelect={() => void openFileRefInSystem(entry.ref!)}>系统打开</DropdownMenuItem>
            <DropdownMenuItem disabled={!isDesktopRuntime()} onSelect={() => void revealFileRefInSystem(entry.ref!)}>在文件管理器中显示</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void writeClipboardText(entry.ref!.relativePath)}>复制相对路径</DropdownMenuItem>
            <DropdownMenuItem disabled={!isDesktopRuntime()} onSelect={() => void props.onCopyAbsolutePath(entry.ref!)}>复制绝对路径</DropdownMenuItem>
            {entry.ref.source === 'legacy' && <DropdownMenuItem onSelect={() => void props.onExportLegacy(entry)}>导出到项目（不覆盖）</DropdownMenuItem>}
            <DropdownMenuItem disabled={!capabilities.rename} onSelect={() => props.onEdit(entry)}>重命名</DropdownMenuItem>
            <DropdownMenuItem disabled={!capabilities.move} onSelect={() => props.onMove(entry)}>移动</DropdownMenuItem>
            <DropdownMenuItem destructive disabled={!capabilities.delete} onSelect={() => props.onDelete(entry)}>删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {entry.isDirectory && open && (props.cache[key] ?? []).map((child) => (
        <TreeEntryRow key={child.ref ? fileRefKey(child.ref) : child.path} {...props} entry={child} depth={props.depth + 1} />
      ))}
    </div>
  )
}

function buildSourceRoots(workspaceSlug?: string, fileContextId?: string): FileRef[] {
  return [
    ...(workspaceSlug ? [{ source: 'project' as const, scopeId: workspaceSlug, relativePath: '' }] : []),
    ...(fileContextId ? [{ source: 'session' as const, scopeId: fileContextId, relativePath: '' }] : []),
    ...(workspaceSlug ? [{ source: 'memory' as const, scopeId: `workspace:${workspaceSlug}`, relativePath: '' }] : []),
    { source: 'memory' as const, scopeId: 'global', relativePath: '' },
    ...(workspaceSlug ? [{ source: 'legacy' as const, scopeId: workspaceSlug, relativePath: '' }] : []),
  ]
}

function handleTreeKeyDown(event: React.KeyboardEvent<HTMLDivElement>, actions: {
  onOpen: (ref: FileRef) => void
  onSelect: (ref: FileRef) => void
  onToggle: (ref: FileRef) => Promise<void>
  onEdit: (ref: FileRef) => void
  onDelete: (ref: FileRef) => void
  onFocusSearch: () => void
  onEscape: () => void
}) {
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-tree-row]'))
  const index = rows.indexOf(document.activeElement as HTMLElement)
  const focus = (next: number) => rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus()
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault(); actions.onFocusSearch(); return
  }
  if (event.key === 'Escape') { actions.onEscape(); return }
  if (event.key === 'ArrowDown') { event.preventDefault(); focus(index + 1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); focus(index - 1) }
  else if (event.key === 'Home') { event.preventDefault(); focus(0) }
  else if (event.key === 'End') { event.preventDefault(); focus(rows.length - 1) }
  else if (index >= 0) {
    const row = rows[index]!
    const encoded = row.dataset.fileRef
    if (!encoded) return
    const ref = JSON.parse(encoded) as FileRef
    const expanded = row.getAttribute('aria-expanded')
    if (event.key === 'Enter' && expanded === null) actions.onOpen(ref)
    else if (event.key === ' ' ) { event.preventDefault(); actions.onSelect(ref) }
    else if (event.key === 'ArrowRight' && expanded !== null) {
      event.preventDefault()
      if (expanded === 'false') void actions.onToggle(ref)
      else focus(index + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (expanded === 'true') void actions.onToggle(ref)
      else rows.find((candidate) => candidate.dataset.fileRefKey === row.dataset.parentRefKey)?.focus()
    } else if (event.key === 'F2') { event.preventDefault(); actions.onEdit(ref) }
    else if (event.key === 'Delete') { event.preventDefault(); actions.onDelete(ref) }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault(); void writeClipboardText(ref.relativePath)
    }
  }
}

function parentPath(path: string) { return path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') }

function collectLoadedDirectories(cache: Record<string, FileEntry[]>, scopeId: string): FileRef[] {
  const directories: FileRef[] = []
  for (const entries of Object.values(cache)) {
    for (const entry of entries) {
      if (entry.isDirectory && entry.ref?.source === 'session' && entry.ref.scopeId === scopeId) directories.push(entry.ref)
    }
  }
  return directories.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function collectVisibleEntryKeys(
  entries: FileEntry[],
  cache: Record<string, FileEntry[]>,
  expanded: Set<string>,
): string[] {
  const keys: string[] = []
  for (const entry of entries) {
    if (!entry.ref) continue
    const key = fileRefKey(entry.ref)
    keys.push(key)
    if (entry.isDirectory && expanded.has(key)) {
      keys.push(...collectVisibleEntryKeys(cache[key] ?? [], cache, expanded))
    }
  }
  return keys
}

function findCachedEntry(cache: Record<string, FileEntry[]>, ref: FileRef): FileEntry | undefined {
  const key = fileRefKey(ref)
  return Object.values(cache).flat().find((entry) => entry.ref && fileRefKey(entry.ref) === key)
}

function patchRenamedCache(cache: Record<string, FileEntry[]>, entry: FileEntry, nextRef: FileRef): Record<string, FileEntry[]> {
  if (!entry.ref) return cache
  const fromRef = entry.ref
  const fromKey = fileRefKey(fromRef)
  const toKey = fileRefKey(nextRef)
  const next: Record<string, FileEntry[]> = {}
  for (const [directoryKey, entries] of Object.entries(cache)) {
    const rewrittenDirectoryKey = directoryKey === fromKey || directoryKey.startsWith(`${fromKey}/`)
      ? `${toKey}${directoryKey.slice(fromKey.length)}`
      : directoryKey
    next[rewrittenDirectoryKey] = entries.map((candidate) => {
      if (!candidate.ref || !isSameOrDescendantRef(candidate.ref, fromRef)) return candidate
      const suffix = candidate.ref.relativePath.slice(fromRef.relativePath.length).replace(/^\//, '')
      const ref = { ...nextRef, relativePath: [nextRef.relativePath, suffix].filter(Boolean).join('/') }
      return {
        ...candidate,
        ref,
        ...(fileRefKey(candidate.ref) === fromKey ? { name: basename(ref.relativePath) } : {}),
      }
    })
  }
  return next
}

function patchMovedCache(
  cache: Record<string, FileEntry[]>,
  entry: FileEntry,
  nextRef: FileRef,
  targetDirectory: FileRef,
): Record<string, FileEntry[]> {
  if (!entry.ref) return cache
  const rewritten = patchRenamedCache(cache, entry, nextRef)
  const oldParentKey = fileRefKey({ ...entry.ref, relativePath: parentPath(entry.ref.relativePath) })
  const targetKey = fileRefKey(targetDirectory)
  const movedEntry = { ...entry, name: basename(nextRef.relativePath), ref: nextRef }
  return {
    ...rewritten,
    [oldParentKey]: (rewritten[oldParentKey] ?? []).filter((candidate) => !candidate.ref || fileRefKey(candidate.ref) !== fileRefKey(nextRef)),
    [targetKey]: [...(rewritten[targetKey] ?? []).filter((candidate) => !candidate.ref || fileRefKey(candidate.ref) !== fileRefKey(nextRef)), movedEntry],
  }
}

function patchDeletedCache(cache: Record<string, FileEntry[]>, target: FileRef, recursive: boolean): Record<string, FileEntry[]> {
  const targetKey = fileRefKey(target)
  const next: Record<string, FileEntry[]> = {}
  for (const [directoryKey, entries] of Object.entries(cache)) {
    if (directoryKey === targetKey || (recursive && directoryKey.startsWith(`${targetKey}/`))) continue
    next[directoryKey] = entries.filter((entry) => !entry.ref || !isSameOrDescendantRef(entry.ref, target, recursive))
  }
  return next
}

function isSameOrDescendantRef(ref: FileRef, target: FileRef, recursive = true): boolean {
  if (ref.source !== target.source || ref.scopeId !== target.scopeId) return false
  return ref.relativePath === target.relativePath
    || (recursive && Boolean(target.relativePath) && ref.relativePath.startsWith(`${target.relativePath}/`))
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path
}
