import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { CaseSensitive, Check, ChevronDown, ChevronRight, Columns2, Copy, ExternalLink, EyeOff, FileSearch, FileText, Folder, FolderOpen, History, Image, ListChevronsDownUp, ListChevronsUpDown, Loader2, MoreHorizontal, RefreshCw, Search, Undo2, WrapText } from 'lucide-react'
import type { HighlightToken } from '@lume/ui'
import type { RuntimeCodingFileChange } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useSourceHighlight } from '@/components/right-panel/RightPanelSourcePreview'
import {
  readSessionCodingDiff,
  removeSessionCodingDiff,
  requestSessionCodingDiff,
  type CodingDiffLine,
  type CodingDiffPayload,
} from '@/components/right-panel/coding-diff-cache'
import { codingReviewFileKey, codingReviewStatusActionAtom, codingReviewStatusAtom, type CodingReviewPanelState } from '@/atoms/right-panel-atoms'
import { sidecarCall, writeClipboardText } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'

interface PreparedDiffPayload {
  hunkLines: CodingDiffLine[]
  fullSections: FullDiffSection[]
  compactSections: FullDiffSection[]
  oldLineCount: number
  newLineCount: number
}

interface DiffFileTreeFile {
  type: 'file'
  name: string
  path: string
}

interface DiffFileTreeFolder {
  type: 'folder'
  name: string
  path: string
  children: DiffFileTreeNode[]
}

type DiffFileTreeNode = DiffFileTreeFile | DiffFileTreeFolder

export function buildDiffFileTree(paths: string[]): DiffFileTreeNode[] {
  const root: DiffFileTreeFolder = { type: 'folder', name: '', path: '', children: [] }

  for (const originalPath of new Set(paths)) {
    const normalizedPath = originalPath.replace(/\\/g, '/')
    const parts = normalizedPath.split('/').filter(Boolean)
    let folder = root
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!
      const path = parts.slice(0, index + 1).join('/')
      if (index === parts.length - 1) {
        folder.children.push({ type: 'file', name, path: originalPath })
        continue
      }
      let child = folder.children.find((node): node is DiffFileTreeFolder => node.type === 'folder' && node.name === name)
      if (!child) {
        child = { type: 'folder', name, path, children: [] }
        folder.children.push(child)
      }
      folder = child
    }
  }

  const compact = (node: DiffFileTreeNode): DiffFileTreeNode => {
    if (node.type === 'file') return node
    let name = node.name
    let path = node.path
    let children = node.children.map(compact)
    while (children.length === 1 && children[0]?.type === 'folder') {
      const child = children[0]
      name = `${name}/${child.name}`
      path = child.path
      children = child.children
    }
    children.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'folder' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    return { type: 'folder', name, path, children }
  }

  return root.children.map(compact).sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

const preparedDiffCache = new WeakMap<CodingDiffPayload, PreparedDiffPayload>()

function getPreparedDiff(payload: CodingDiffPayload): PreparedDiffPayload {
  const cached = preparedDiffCache.get(payload)
  if (cached) return cached
  const hunkLines = payload.lines.length > 0
    ? payload.lines
    : createFallbackDiffLines(payload.oldContent, payload.newContent)
  const prepared = {
    hunkLines,
    fullSections: buildFullDiffSections(hunkLines, payload.oldContent, payload.newContent),
    compactSections: collapseUnmodifiedRuns(hunkLines),
    oldLineCount: countDiffContentLines(payload.oldContent),
    newLineCount: countDiffContentLines(payload.newContent),
  }
  preparedDiffCache.set(payload, prepared)
  return prepared
}

function diffStateKey(source: 'session' | 'workspace', runId: string | undefined, change: Pick<RuntimeCodingFileChange, 'path' | 'rootId'>): string {
  return `${source}:${source === 'session' ? runId ?? '' : ''}:${codingReviewFileKey(change)}`
}

function selectedChangeKey(state: CodingReviewPanelState): string {
  return state.selectedPath
    ? codingReviewFileKey({ path: state.selectedPath, rootId: state.selectedRootId })
    : ''
}

export function CodingReviewPanel({ threadId, state, onOpenFile }: {
  threadId: string
  state: CodingReviewPanelState
  onOpenFile?: (path: string) => void
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(selectedChangeKey(state) ? [selectedChangeKey(state)] : []))
  const [activeTab, setActiveTab] = useState<'session' | 'workspace' | 'changes'>('session')
  const [workspaceChanges, setWorkspaceChanges] = useState<RuntimeCodingFileChange[]>([])
  const [branch, setBranch] = useState<{ name: string; upstream?: string } | undefined>()
  const [reviews, setReviews] = useState<Record<string, CodingDiffPayload>>({})
  const [loadingDiffs, setLoadingDiffs] = useState<Set<string>>(() => new Set())
  const [diffErrors, setDiffErrors] = useState<Record<string, string>>({})
  const [reverting, setReverting] = useState(false)
  const [rewinding, setRewinding] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [diffRequestKey, setDiffRequestKey] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpQuery, setJumpQuery] = useState('')
  const [wrapDiffLines, setWrapDiffLines] = useState(false)
  const [omitFullFile, setOmitFullFile] = useState(false)
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified')
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
  const [treeQuery, setTreeQuery] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [activeDiffPath, setActiveDiffPath] = useState(selectedChangeKey(state))
  const localDiffCache = useRef(new Map<string, CodingDiffPayload>())
  const localDiffRequests = useRef(new Map<string, Promise<CodingDiffPayload>>())
  const localDiffGeneration = useRef(0)
  const fileRowRefs = useRef(new Map<string, HTMLDivElement>())
  const reviewStatus = useAtomValue(codingReviewStatusAtom)[threadId]
  const reviewStatusAction = useSetAtom(codingReviewStatusActionAtom)
  const [pendingRewind, setPendingRewind] = useState<{ operationId: string; status: string; error?: string } | null>(null)
  const visibleChanges = activeTab === 'workspace' ? workspaceChanges : state.changes
  const jumpChanges = visibleChanges.filter((change) => change.path.toLowerCase().includes(jumpQuery.trim().toLowerCase()))
  const fileTree = useMemo(
    () => buildDiffFileTree(visibleChanges
      .filter((change) => change.path.toLowerCase().includes(treeQuery.trim().toLowerCase()))
      .map((change) => change.path)),
    [treeQuery, visibleChanges],
  )
  const totalAdded = visibleChanges.reduce((sum, change) => sum + (change.addedLines ?? 0), 0)
  const totalRemoved = visibleChanges.reduce((sum, change) => sum + (change.removedLines ?? 0), 0)
  const unseenCount = reviewStatus?.unseenPaths.length ?? visibleChanges.length
  const allDiffsExpanded = visibleChanges.length > 0 && visibleChanges.every((change) => expandedPaths.has(codingReviewFileKey(change)))
  const preloadChanges = useMemo(
    () => state.changes
      .filter((change) => change.state !== 'unpreviewable' && (change.oldContentAvailable !== false || change.newContentAvailable !== false)),
    [state.changes],
  )

  const getCachedDiff = useCallback((change: Pick<RuntimeCodingFileChange, 'path' | 'rootId'>, source: 'session' | 'workspace') => {
    if (source === 'session' && state.runId) {
      return readSessionCodingDiff(threadId, state.runId, change.path, change.rootId)
    }
    return localDiffCache.current.get(diffStateKey(source, state.runId, change))
  }, [state.runId, threadId])

  const loadDiff = useCallback((change: Pick<RuntimeCodingFileChange, 'path' | 'rootId'>, source: 'session' | 'workspace') => {
    if (source === 'session' && state.runId) {
      return requestSessionCodingDiff(threadId, state.runId, change.path, change.rootId)
    }
    const key = diffStateKey(source, state.runId, change)
    const cached = localDiffCache.current.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = localDiffRequests.current.get(key)
    if (pending) return pending
    const generation = localDiffGeneration.current
    const request = sidecarCall<CodingDiffPayload>(AGENT_IPC_CHANNELS.GET_CODING_DIFF, {
      threadId,
      path: change.path,
      rootId: change.rootId,
      runId: source === 'session' ? state.runId : undefined,
    }).then((payload) => {
      if (generation === localDiffGeneration.current) {
        localDiffCache.current.set(key, payload)
      }
      return payload
    }).finally(() => {
      if (localDiffRequests.current.get(key) === request) localDiffRequests.current.delete(key)
    })
    localDiffRequests.current.set(key, request)
    return request
  }, [state.runId, threadId])

  const invalidateLocalDiffs = useCallback(() => {
    localDiffGeneration.current += 1
    localDiffCache.current.clear()
    localDiffRequests.current.clear()
  }, [])

  useEffect(() => {
    void sidecarCall<{ files?: RuntimeCodingFileChange[]; branch?: { name: string; upstream?: string }; pendingRewind?: { operationId: string; status: string; error?: string } } | RuntimeCodingFileChange[]>(AGENT_IPC_CHANNELS.GET_CODING_CHANGE_SET, { threadId, runId: state.runId })
      .then((result) => {
        if (Array.isArray(result)) {
          setWorkspaceChanges(result)
          return
        }
        setWorkspaceChanges(result.files ?? [])
        setBranch(result.branch)
        setPendingRewind(result.pendingRewind ?? null)
      })
      .catch(() => setWorkspaceChanges([]))
  }, [refreshKey, state.runId, threadId])

  useEffect(() => {
    const selectedKey = selectedChangeKey(state)
    setExpandedPaths(new Set(selectedKey ? [selectedKey] : []))
    setActiveDiffPath(selectedKey)
  }, [state.selectedPath, state.selectedRootId])

  useEffect(() => {
    const source = activeTab === 'workspace' ? 'workspace' : 'session'
    let cancelled = false
    const cachedReviews: Record<string, CodingDiffPayload> = {}
    const pathsToLoad: Array<{ change: RuntimeCodingFileChange; key: string }> = []
    for (const change of visibleChanges) {
      if (!expandedPaths.has(codingReviewFileKey(change))) continue
      const key = diffStateKey(source, state.runId, change)
      const cached = getCachedDiff(change, source)
      if (cached) {
        cachedReviews[key] = cached
        continue
      }
      pathsToLoad.push({ change, key })
    }
    const resolvedKeys = [...Object.keys(cachedReviews), ...pathsToLoad.map(({ key }) => key)]
    if (Object.keys(cachedReviews).length > 0) {
      setReviews((current) => ({ ...current, ...cachedReviews }))
    }
    if (resolvedKeys.length > 0) {
      setDiffErrors((current) => {
        if (!resolvedKeys.some((key) => key in current)) return current
        const next = { ...current }
        for (const key of resolvedKeys) delete next[key]
        return next
      })
    }
    if (pathsToLoad.length === 0) return () => { cancelled = true }

    setLoadingDiffs((current) => {
      const next = new Set(current)
      for (const { key } of pathsToLoad) next.add(key)
      return next
    })
    let frameId: number | undefined
    let loaded: Record<string, CodingDiffPayload> = {}
    let errors: Record<string, string> = {}
    let completedKeys = new Set<string>()
    const flush = () => {
      frameId = undefined
      if (cancelled) return
      if (Object.keys(loaded).length > 0) setReviews((current) => ({ ...current, ...loaded }))
      if (Object.keys(errors).length > 0) setDiffErrors((current) => ({ ...current, ...errors }))
      setLoadingDiffs((current) => {
        const next = new Set(current)
        for (const key of completedKeys) next.delete(key)
        return next
      })
      loaded = {}
      errors = {}
      completedKeys = new Set()
    }
    const scheduleFlush = () => {
      if (cancelled || frameId !== undefined) return
      frameId = window.requestAnimationFrame(flush)
    }
    for (const { change, key } of pathsToLoad) {
      void loadDiff(change, source).then((payload) => {
        loaded[key] = payload
      }).catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        errors[key] = message.includes('unsupported renderer sidecar method')
          ? '当前桌面端未加载 Coding diff RPC，请重启 Lume 后重试。'
          : message || '无法加载 Coding diff'
      }).finally(() => {
        completedKeys.add(key)
        scheduleFlush()
      })
    }
    return () => {
      cancelled = true
      if (frameId !== undefined) window.cancelAnimationFrame(frameId)
    }
  }, [activeTab, diffRequestKey, expandedPaths, getCachedDiff, loadDiff, state.runId, visibleChanges])

  useEffect(() => {
    if (!state.runId || preloadChanges.length === 0) return
    let cancelled = false
    const queue = preloadChanges.filter((change) => !getCachedDiff(change, 'session'))
    const timer = window.setTimeout(() => {
      const worker = async () => {
        while (!cancelled) {
          const change = queue.shift()
          if (!change) return
          await loadDiff(change, 'session').catch(() => undefined)
        }
      }
      void Promise.all([worker(), worker()])
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [getCachedDiff, loadDiff, preloadChanges, state.runId])

  const prefetchDiff = useCallback((change: RuntimeCodingFileChange) => {
    const source = activeTab === 'workspace' ? 'workspace' : 'session'
    if (getCachedDiff(change, source)) return
    void loadDiff(change, source).catch(() => undefined)
  }, [activeTab, getCachedDiff, loadDiff])

  const refreshDiffs = () => {
    invalidateLocalDiffs()
    if (state.runId) {
      for (const change of state.changes) {
        removeSessionCodingDiff(threadId, state.runId, change.path, change.rootId)
      }
    }
    setReviews({})
    setDiffErrors({})
    setLoadingDiffs(new Set())
    setActionError(null)
    setRefreshKey((value) => value + 1)
    setDiffRequestKey((value) => value + 1)
  }

  const retryDiff = (change: RuntimeCodingFileChange) => {
    const source = activeTab === 'workspace' ? 'workspace' : 'session'
    const key = diffStateKey(source, state.runId, change)
    if (source === 'session' && state.runId) removeSessionCodingDiff(threadId, state.runId, change.path, change.rootId)
    else localDiffCache.current.delete(key)
    setReviews((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    setDiffErrors((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    setDiffRequestKey((value) => value + 1)
  }

  const toggleAllDiffs = () => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (visibleChanges.every((change) => next.has(codingReviewFileKey(change)))) {
        for (const change of visibleChanges) next.delete(codingReviewFileKey(change))
      } else {
        for (const change of visibleChanges) next.add(codingReviewFileKey(change))
      }
      return next
    })
  }

  const toggleDiff = (change: RuntimeCodingFileChange) => {
    const key = codingReviewFileKey(change)
    setActiveDiffPath(key)
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const jumpToDiff = (change: RuntimeCodingFileChange) => {
    const key = codingReviewFileKey(change)
    setActiveDiffPath(key)
    setExpandedPaths((current) => new Set(current).add(key))
    setJumpOpen(false)
    setJumpQuery('')
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        fileRowRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }

  const switchChangeSource = () => {
    setActiveTab((current) => current === 'session' ? 'workspace' : 'session')
    setExpandedPaths(new Set())
    setActiveDiffPath('')
    setTreeQuery('')
  }

  const revertRun = async () => {
    if (!state.onRevertRun) return
    setReverting(true)
    try {
      await state.onRevertRun()
    } finally {
      setReverting(false)
    }
  }

  const rewindTurn = async () => {
    if (!state.onRewindTurn) return
    setRewinding(true)
    try {
      await state.onRewindTurn()
    } finally {
      setRewinding(false)
    }
  }

  const revertFile = async (change: RuntimeCodingFileChange) => {
    if (!state.runId) return
    setReverting(true)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.REVERT_CODING_FILE, {
        threadId,
        path: change.path,
        rootId: change.rootId,
        runId: state.runId,
      })
      invalidateLocalDiffs()
      setActionError(null)
      setDiffRequestKey((value) => value + 1)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '无法撤销文件变更')
    } finally {
      setReverting(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[var(--lume-bg-panel)] text-[var(--lume-text-primary)]" aria-label="Coding 变更审核">
      <header className="shrink-0 border-b border-[var(--lume-border-subtle)]">
        <div className="flex h-10 items-center gap-2 px-3">
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-1 text-[13px] font-medium text-[var(--lume-text-primary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]" onClick={switchChangeSource}>
            {activeTab === 'workspace' ? '工作区' : '分支'} <ChevronDown className="size-3.5 text-[var(--lume-text-muted)]" />
          </Button>
          <span className="text-[12px] tabular-nums text-[var(--lume-success)]">+{totalAdded}</span>
          <span className="text-[12px] tabular-nums text-[var(--lume-danger)]">-{totalRemoved}</span>
          <div className="ml-auto flex min-w-0 items-center gap-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]" title="更多选项" aria-label="更多审阅选项" />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-52">
                <DropdownMenuItem onSelect={refreshDiffs}><RefreshCw className="size-3.5" />刷新</DropdownMenuItem>
                <DropdownMenuItem disabled={diffViewMode === 'split'} title={diffViewMode === 'split' ? '左右差异视图保持单行以保证行对齐' : undefined} onSelect={() => setWrapDiffLines((enabled) => !enabled)}>
                  <WrapText className="size-3.5" />启用自动换行
                  {wrapDiffLines && diffViewMode === 'unified' && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setOmitFullFile((enabled) => !enabled)}>
                  <FileText className="size-3.5" />不加载完整文件
                  {omitFullFile && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
                <DropdownMenuItem disabled title="富文本 Diff 预览尚未接入"><Image className="size-3.5" />启用富文本预览</DropdownMenuItem>
                <DropdownMenuItem disabled title="文字级 Diff 尚未接入"><CaseSensitive className="size-3.5" />启用文字差异</DropdownMenuItem>
                <DropdownMenuItem disabled title="当前 Diff 默认不显示空白字符"><EyeOff className="size-3.5" />隐藏空白字符</DropdownMenuItem>
                <DropdownMenuItem disabled title="git apply 命令尚未接入"><Copy className="size-3.5" />复制 git apply 命令</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
              title={allDiffsExpanded ? '全部收起' : '全部展开'}
              aria-label={allDiffsExpanded ? '收起全部文件 Diff' : '展开全部文件 Diff'}
              disabled={visibleChanges.length === 0}
              onClick={toggleAllDiffs}
            >
              {allDiffsExpanded ? <ListChevronsDownUp /> : <ListChevronsUpDown />}
            </Button>
            <Popover open={jumpOpen} onOpenChange={(open) => {
              setJumpOpen(open)
              if (!open) setJumpQuery('')
            }}>
              <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className={cn('text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]', jumpOpen && 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)]')} title="跳转到文件" aria-label="跳转到文件" />}>
                <FileSearch />
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" sideOffset={6} className="w-[min(28rem,calc(100vw-2rem))]">
                <div className="flex h-9 items-center gap-2 border-b border-[var(--lume-border-subtle)] px-2.5">
                  <Search className="size-3.5 shrink-0 text-[var(--lume-text-muted)]" />
                  <Input
                    autoFocus
                    value={jumpQuery}
                    onChange={(event) => setJumpQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && jumpChanges[0]) jumpToDiff(jumpChanges[0])
                    }}
                    placeholder="跳转到文件"
                    aria-label="搜索要跳转的 Diff 文件"
                    className="h-8 flex-1 border-0 bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto p-1">
                  {jumpChanges.map((change) => (
                    <Button
                      key={codingReviewFileKey(change)}
                      variant="ghost"
                      size="sm"
                      className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] font-normal text-[var(--lume-text-secondary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
                      onPointerEnter={() => prefetchDiff(change)}
                      onFocus={() => prefetchDiff(change)}
                      onClick={() => jumpToDiff(change)}
                    >
                      <JumpFileLabel path={change.path} />
                    </Button>
                  ))}
                  {jumpChanges.length === 0 && <div className="px-2 py-4 text-center text-[12px] text-[var(--lume-text-muted)]">没有匹配的文件</div>}
                </div>
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]',
                diffViewMode === 'split' && 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)]',
              )}
              title={diffViewMode === 'unified' ? '切换到左右差异视图' : '切换到统一差异视图'}
              aria-label={diffViewMode === 'unified' ? '切换到左右差异视图' : '切换到统一差异视图'}
              onClick={() => setDiffViewMode((mode) => mode === 'unified' ? 'split' : 'unified')}
            >
              <Columns2 />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]',
                fileTreeOpen && 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)]',
              )}
              title={fileTreeOpen ? '隐藏文件' : '显示文件'}
              aria-label={fileTreeOpen ? '隐藏 Diff 文件树' : '显示 Diff 文件树'}
              onClick={() => setFileTreeOpen((open) => !open)}
            >
              {fileTreeOpen ? <FolderOpen /> : <Folder />}
            </Button>
            {state.onRevertRun && <Button variant="ghost" size="icon-sm" className="text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]" disabled={reverting} title="撤销本次 Coding Run" onClick={() => void revertRun()}><Undo2 /></Button>}
            {state.onRewindTurn && <Button variant="ghost" size="icon-sm" className="text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]" disabled={rewinding} title="回退会话" onClick={() => void rewindTurn()}><History /></Button>}
            <Button variant="outline" size="sm" className="ml-1 h-7 gap-1 border-[var(--lume-border-strong)] bg-transparent px-2.5 text-[12px] text-[var(--lume-text-primary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]" disabled title="提交和推送尚未接入"><span>提交或推送</span><ChevronDown className="size-3.5" /></Button>
          </div>
        </div>
        <div className="flex h-8 items-center gap-2 px-3 text-[12px] text-[var(--lume-text-muted)]">
          <span className="text-[var(--lume-text-secondary)]">{branch?.name ?? '当前分支'}</span>
          <span>→</span>
          <span className="text-[var(--lume-text-secondary)]">{branch?.upstream ?? '未设置上游'}</span>
          <ChevronDown className="size-3.5 text-[var(--lume-text-muted)]" />
          {unseenCount > 0 && <span className="ml-auto text-[11px] text-[var(--lume-text-muted)]">{unseenCount} 个未查看</span>}
        </div>
      </header>
      {pendingRewind && <div className="border-b border-[color:color-mix(in_oklab,var(--lume-warning)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-warning)_10%,var(--lume-bg-panel))] px-3 py-1.5 text-[11px] text-[var(--lume-warning)]">存在未完成的回退事务（{pendingRewind.operationId.slice(0, 8)}…，{pendingRewind.status}）。{pendingRewind.error && <span className="ml-1 opacity-80">{pendingRewind.error}</span>}</div>}
      {actionError && <div className="border-b border-[color:color-mix(in_oklab,var(--lume-danger)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,var(--lume-bg-panel))] px-3 py-1.5 text-[11px] text-[var(--lume-danger)]">{actionError}</div>}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-auto">
          {visibleChanges.map((change, index) => {
            const source = activeTab === 'workspace' ? 'workspace' : 'session'
            const fileKey = codingReviewFileKey(change)
            const key = diffStateKey(source, state.runId, change)
            const expanded = expandedPaths.has(fileKey)
            const rowRef = (element: HTMLDivElement | null) => {
              if (element) fileRowRefs.current.set(fileKey, element)
              else fileRowRefs.current.delete(fileKey)
            }
            return (
              <Fragment key={fileKey}>
                {expanded ? <InlineFileDiff rowRef={rowRef} change={change} review={reviews[key] ?? null} loading={loadingDiffs.has(key)} error={diffErrors[key] ?? null} viewMode={diffViewMode} wrapLines={wrapDiffLines} omitFullFile={omitFullFile} eager={fileKey === activeDiffPath || index === 0} unseen={reviewStatus?.unseenPaths.includes(fileKey) ?? false} onRetry={() => retryDiff(change)} onCollapse={() => toggleDiff(change)} onOpenFile={onOpenFile} onMarkReviewed={() => reviewStatusAction({ type: 'mark-reviewed', threadId, path: fileKey })} onRevert={() => void revertFile(change)} canRevert={Boolean(state.runId && change.canUndo && change.state !== 'conflict' && change.state !== 'external_modified' && change.state !== 'committed')} /> : <ChangeFileButton rowRef={rowRef} change={change} unseen={reviewStatus?.unseenPaths.includes(fileKey) ?? false} onPrefetch={() => prefetchDiff(change)} onClick={() => toggleDiff(change)} onOpenFile={onOpenFile} onMarkReviewed={() => reviewStatusAction({ type: 'mark-reviewed', threadId, path: fileKey })} />}
              </Fragment>
            )
          })}
          {visibleChanges.length === 0 && <div className="p-6 text-center text-[12px] text-[var(--lume-text-muted)]">没有文件变更</div>}
        </div>
        {fileTreeOpen && (
          <aside className="absolute inset-y-0 right-0 z-20 flex w-[min(19rem,82%)] flex-col border-l border-[var(--lume-border-strong)] bg-[var(--lume-bg-panel)] shadow-[-18px_0_32px_-28px_hsl(var(--shadow-panel)/0.75)]" aria-label="Diff 文件树">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--lume-border-subtle)] px-2.5">
              <Search className="size-3.5 shrink-0 text-[var(--lume-text-muted)]" />
              <Input
                autoFocus
                value={treeQuery}
                onChange={(event) => setTreeQuery(event.target.value)}
                placeholder="筛选文件…"
                aria-label="筛选 Diff 文件树"
                className="h-8 flex-1 border-0 bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {fileTree.map((node) => (
                <DiffFileTreeItem
                  key={`${node.type}:${node.path}`}
                  node={node}
                  depth={0}
                  activePath={visibleChanges.find((change) => codingReviewFileKey(change) === activeDiffPath)?.path ?? ''}
                  collapsedFolders={collapsedFolders}
                  onToggleFolder={(path) => setCollapsedFolders((current) => {
                    const next = new Set(current)
                    if (next.has(path)) next.delete(path)
                    else next.add(path)
                    return next
                  })}
                  onPrefetchFile={(path) => {
                    const change = visibleChanges.find((candidate) => candidate.path === path)
                    if (change) prefetchDiff(change)
                  }}
                  onSelectFile={(path) => {
                    const change = visibleChanges.find((candidate) => candidate.path === path)
                    if (change) jumpToDiff(change)
                  }}
                />
              ))}
              {fileTree.length === 0 && <div className="px-3 py-5 text-center text-[12px] text-[var(--lume-text-muted)]">没有匹配的文件</div>}
            </div>
          </aside>
        )}
      </div>
    </section>
  )
}

function DiffFileTreeItem({ node, depth, activePath, collapsedFolders, onToggleFolder, onPrefetchFile, onSelectFile }: {
  node: DiffFileTreeNode
  depth: number
  activePath: string
  collapsedFolders: Set<string>
  onToggleFolder: (path: string) => void
  onPrefetchFile: (path: string) => void
  onSelectFile: (path: string) => void
}) {
  if (node.type === 'file') {
    const active = node.path === activePath
    return (
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 w-full justify-start gap-2 rounded-none pr-2 text-left text-[12px] font-normal text-[var(--lume-text-secondary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]',
          active && 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)]',
        )}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        title={node.path}
        onPointerEnter={() => onPrefetchFile(node.path)}
        onFocus={() => onPrefetchFile(node.path)}
        onClick={() => onSelectFile(node.path)}
      >
        <FileTypeIcon filename={node.path} size={14} />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className={cn(
          'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-[var(--lume-warning)]',
          active && 'bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,transparent)]',
        )}>
          <span className="size-1 rounded-full bg-[var(--lume-warning)]" />
        </span>
      </Button>
    )
  }

  const collapsed = collapsedFolders.has(node.path)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-full justify-start gap-1.5 rounded-none pr-2 text-left text-[12px] font-normal text-[var(--lume-text-secondary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={node.path}
        onClick={() => onToggleFolder(node.path)}
        aria-expanded={!collapsed}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
        {collapsed ? <Folder className="size-3.5 shrink-0 text-[var(--lume-text-muted)]" /> : <FolderOpen className="size-3.5 shrink-0 text-[var(--lume-text-muted)]" />}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </Button>
      {!collapsed && node.children.map((child) => (
        <DiffFileTreeItem
          key={`${child.type}:${child.path}`}
          node={child}
          depth={depth + 1}
          activePath={activePath}
          collapsedFolders={collapsedFolders}
          onToggleFolder={onToggleFolder}
          onPrefetchFile={onPrefetchFile}
          onSelectFile={onSelectFile}
        />
      ))}
    </>
  )
}

export function estimateDiffBodyHeight(payload: Pick<CodingDiffPayload, 'lines'>): number {
  let groups = payload.lines.length > 0 ? 1 : 0
  let expectedOldLine: number | undefined
  let expectedNewLine: number | undefined
  for (const line of payload.lines) {
    if (
      (line.oldLine !== undefined && expectedOldLine !== undefined && line.oldLine > expectedOldLine)
      || (line.newLine !== undefined && expectedNewLine !== undefined && line.newLine > expectedNewLine)
    ) {
      groups += 1
    }
    if (line.type !== 'added' && line.oldLine !== undefined) expectedOldLine = line.oldLine + 1
    if (line.type !== 'removed' && line.newLine !== undefined) expectedNewLine = line.newLine + 1
  }
  return Math.max(80, Math.min(900, payload.lines.length * 20 + Math.max(1, groups) * 28))
}

function InlineFileDiff({ rowRef, change, review, loading, error, viewMode, wrapLines, omitFullFile, eager, unseen, onRetry, onCollapse, onOpenFile, onMarkReviewed, onRevert, canRevert }: {
  rowRef: (element: HTMLDivElement | null) => void
  change: RuntimeCodingFileChange
  review: CodingDiffPayload | null
  loading: boolean
  error: string | null
  viewMode: 'unified' | 'split'
  wrapLines: boolean
  omitFullFile: boolean
  eager: boolean
  unseen: boolean
  onRetry: () => void
  onCollapse: () => void
  onOpenFile?: (path: string) => void
  onMarkReviewed: () => void
  onRevert: () => void
  canRevert: boolean
}) {
  const path = change.path
  const [copied, setCopied] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [nearViewport, setNearViewport] = useState(eager)
  useEffect(() => {
    if (eager) setNearViewport(true)
  }, [eager])
  useEffect(() => {
    if (nearViewport) return
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setNearViewport(true)
    }, { rootMargin: '700px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [nearViewport])
  const copyDiff = async () => {
    if (!review) return
    const lines = review.lines.length > 0 ? review.lines : createFallbackDiffLines(review.oldContent, review.newContent)
    const content = lines.map((line) => `${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}${line.text}`).join('\n')
    await writeClipboardText(content || review.newContent)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const addedLines = review?.addedLines ?? change.addedLines ?? 0
  const removedLines = review?.removedLines ?? change.removedLines ?? 0

  return (
    <div
      ref={(element) => {
        containerRef.current = element
        rowRef(element)
      }}
      className="scroll-mt-1 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)]"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '0 360px' }}
    >
      <div className="group flex h-8 items-center border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] text-[12px] transition-colors hover:bg-[color:color-mix(in_oklab,var(--lume-text-primary)_5%,transparent)]">
        <Button variant="ghost" size="sm" className="h-full min-w-0 flex-1 justify-start gap-2 rounded-none px-3 text-left font-normal hover:bg-transparent" onClick={onCollapse} title="收起 Diff">
          <FileTypeIcon filename={path} size={14} />
          <FileChangeLabel path={path} addedLines={addedLines} removedLines={removedLines} emphasized />
          <ChevronDown className="size-3.5 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
        </Button>
        {onOpenFile && change.status !== 'deleted' && <Button variant="ghost" size="icon-sm" className="pointer-events-none size-6 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-text-primary)]" onClick={() => onOpenFile(path)} title="在标签中打开" aria-label={`在标签中打开 ${path}`}><ExternalLink className="size-3.5" /></Button>}
        {canRevert && <Button variant="ghost" size="icon-sm" className="pointer-events-none size-6 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-text-primary)]" onClick={onRevert} title="撤销此文件" aria-label="撤销此文件"><Undo2 className="size-3.5" /></Button>}
        {review && <Button variant="ghost" size="icon-sm" className="pointer-events-none size-6 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-text-primary)]" onClick={() => void copyDiff()} title="复制 Diff" aria-label="复制 Diff">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button>}
        {unseen && <Button variant="ghost" size="sm" className="pointer-events-none ml-auto mr-2 h-7 shrink-0 px-2 text-[12px] text-[var(--lume-text-secondary)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-text-primary)]" onClick={onMarkReviewed}>标记为已查看</Button>}
      </div>
      {loading ? (
        <div className="flex min-h-20 items-center justify-center text-[12px] text-[var(--lume-text-muted)]"><Loader2 className="mr-2 size-3.5 animate-spin" />正在加载文件内容…</div>
      ) : error ? (
        <div className="flex min-h-16 items-start gap-2 px-3 py-2 text-[12px] text-[var(--lume-text-secondary)]"><span className="min-w-0 flex-1 break-words"><span className="font-medium text-[var(--lume-text-primary)]">完整文件内容加载失败：</span>{error}</span><Button variant="outline" size="sm" className="h-6 shrink-0 border-[var(--lume-border-strong)] bg-transparent px-2 text-[11px] text-[var(--lume-text-primary)] hover:bg-[var(--lume-bg-elevated)]" onClick={onRetry}>重试</Button></div>
      ) : review && nearViewport ? (
        <UnifiedDiffPane
          payload={review}
          viewMode={viewMode}
          wrapLines={wrapLines}
          omitFullFile={omitFullFile}
          highlightEnabled={nearViewport}
        />
      ) : review ? (
        <div
          aria-hidden
          className="bg-[var(--lume-bg-rail)]"
          style={{
            height: `${estimateDiffBodyHeight(review)}px`,
            maxHeight: 'calc(100vh - 9rem)',
          }}
        />
      ) : null}
    </div>
  )
}

function ChangeFileButton({ rowRef, change, unseen, onPrefetch, onClick, onOpenFile, onMarkReviewed }: {
  rowRef: (element: HTMLDivElement | null) => void
  change: RuntimeCodingFileChange
  unseen: boolean
  onPrefetch: () => void
  onClick: () => void
  onOpenFile?: (path: string) => void
  onMarkReviewed: () => void
}) {
  return (
    <div ref={rowRef} className="group flex h-8 w-full scroll-mt-1 items-center border-b border-[var(--lume-border-subtle)] text-[var(--lume-text-secondary)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--lume-text-primary)_5%,transparent)]">
      <Button
        variant="ghost"
        size="sm"
        className="h-full min-w-0 justify-start gap-2 rounded-none px-3 text-left text-[12px] font-normal text-inherit hover:bg-transparent hover:text-[var(--lume-text-primary)]"
        onPointerEnter={onPrefetch}
        onFocus={onPrefetch}
        onClick={onClick}
      >
        <FileTypeIcon filename={change.path} size={14} />
        <FileChangeLabel path={change.path} addedLines={change.addedLines} removedLines={change.removedLines} emphasized={unseen} />
        {change.state && change.state !== 'normal' && (
          <span className="shrink-0 text-[10px] text-[var(--lume-warning)]">
            {change.state === 'committed' ? '已提交' : change.state === 'unpreviewable' ? '不可预览' : change.state === 'external_modified' ? '外部修改' : '冲突'}
          </span>
        )}
        <ChevronRight className="size-3.5 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
      </Button>
      {onOpenFile && change.status !== 'deleted' && <Button variant="ghost" size="icon-sm" className="pointer-events-none size-6 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-text-primary)]" title="在标签中打开" aria-label={`在标签中打开 ${change.path}`} onClick={() => onOpenFile(change.path)}><ExternalLink className="size-3.5" /></Button>}
      {unseen && <Button variant="ghost" size="sm" className="pointer-events-none ml-auto mr-2 h-7 shrink-0 px-2 text-[12px] text-[var(--lume-text-secondary)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-text-primary)]" onClick={onMarkReviewed}>标记为已查看</Button>}
    </div>
  )
}

function JumpFileLabel({ path }: { path: string }) {
  const normalizedPath = path.replace(/\\/g, '/')
  const separator = normalizedPath.lastIndexOf('/')
  const directory = separator >= 0 ? normalizedPath.slice(0, separator) : ''
  const filename = separator >= 0 ? normalizedPath.slice(separator + 1) : normalizedPath

  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      <span className="shrink-0 text-[var(--lume-text-primary)]">{filename}</span>
      {directory && <span className="min-w-0 truncate text-[var(--lume-text-muted)]">{directory}</span>}
    </span>
  )
}

function FileChangeLabel({ path, addedLines, removedLines, emphasized = false }: {
  path: string
  addedLines?: number
  removedLines?: number
  emphasized?: boolean
}) {
  const normalizedPath = path.replace(/\\/g, '/')
  const separator = normalizedPath.lastIndexOf('/')
  const directory = separator >= 0 ? normalizedPath.slice(0, separator + 1) : ''
  const filename = separator >= 0 ? normalizedPath.slice(separator + 1) : normalizedPath

  return (
    <span className="flex min-w-0 items-center overflow-hidden">
      <span className="flex min-w-0 items-center overflow-hidden">
        {directory && <span className="min-w-0 truncate text-[var(--lume-text-muted)]">{directory}</span>}
        <span className={cn('shrink-0 truncate text-[var(--lume-text-secondary)]', directory ? 'max-w-[55%]' : 'max-w-full', emphasized && 'font-medium text-[var(--lume-text-primary)]')}>{filename}</span>
      </span>
      {(typeof addedLines === 'number' || typeof removedLines === 'number') && (
        <span className="ml-2 shrink-0 tabular-nums">
          <span className="text-[var(--lume-success)]">+{addedLines ?? 0}</span>
          <span className="ml-1 text-[var(--lume-danger)]">-{removedLines ?? 0}</span>
        </span>
      )}
    </span>
  )
}

interface DiffLineSection {
  type: 'lines'
  id: string
  lines: CodingDiffLine[]
}

interface CollapsedDiffSection {
  type: 'collapsed'
  id: string
  lines: CodingDiffLine[]
}

type FullDiffSection = DiffLineSection | CollapsedDiffSection

const DIFF_CONTEXT_LINES = 3
const MAX_DIFF_HIGHLIGHT_CHARACTERS = 160_000

interface DiffHighlightSlice {
  code: string
  lineNumbers: number[]
}

export function buildDiffHighlightSlice(lines: CodingDiffLine[], side: 'old' | 'new'): DiffHighlightSlice {
  const selected = lines.filter((line) => side === 'old'
    ? line.type !== 'added' && line.oldLine !== undefined
    : line.type !== 'removed' && line.newLine !== undefined)
  return {
    code: selected.map((line) => line.text).join('\n'),
    lineNumbers: selected.map((line) => side === 'old' ? line.oldLine! : line.newLine!),
  }
}

function UnifiedDiffPane({ payload, viewMode, wrapLines, omitFullFile, highlightEnabled }: {
  payload: CodingDiffPayload
  viewMode: 'unified' | 'split'
  wrapLines: boolean
  omitFullFile: boolean
  highlightEnabled: boolean
}) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set())
  const prepared = useMemo(() => getPreparedDiff(payload), [payload])
  const sections = omitFullFile ? prepared.compactSections : prepared.fullSections
  const visibleLines = useMemo(
    () => sections.flatMap((section) => section.type === 'lines' || expandedSections.has(section.id) ? section.lines : []),
    [expandedSections, sections],
  )
  const oldSlice = useMemo(() => buildDiffHighlightSlice(visibleLines, 'old'), [visibleLines])
  const newSlice = useMemo(() => buildDiffHighlightSlice(visibleLines, 'new'), [visibleLines])
  const oldSource = useSourceHighlight(highlightEnabled ? oldSlice.code : '', payload.path, { defer: true, enabled: highlightEnabled, maxCharacters: MAX_DIFF_HIGHLIGHT_CHARACTERS })
  const newSource = useSourceHighlight(highlightEnabled ? newSlice.code : '', payload.path, { defer: true, enabled: highlightEnabled, maxCharacters: MAX_DIFF_HIGHLIGHT_CHARACTERS })
  const oldTokens = useMemo(() => new Map(oldSlice.lineNumbers.map((lineNumber, index) => [
    lineNumber,
    oldSource.highlighted?.lines[index] ?? [],
  ])), [oldSlice.lineNumbers, oldSource.highlighted])
  const newTokens = useMemo(() => new Map(newSlice.lineNumbers.map((lineNumber, index) => [
    lineNumber,
    newSource.highlighted?.lines[index] ?? [],
  ])), [newSlice.lineNumbers, newSource.highlighted])
  const backgroundColor = newSource.highlighted?.bgColor ?? oldSource.highlighted?.bgColor ?? 'var(--surface-2)'
  const foregroundColor = newSource.highlighted?.fgColor ?? oldSource.highlighted?.fgColor ?? 'var(--text-1)'
  const gutterWidth = `${Math.max(3, String(Math.max(prepared.oldLineCount, prepared.newLineCount)).length + 1)}ch`

  useEffect(() => {
    setExpandedSections(new Set())
  }, [payload])

  const toggleSection = (id: string) => {
    setExpandedSections((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="min-w-0 overflow-hidden border border-t-0 border-[var(--lume-border-subtle)]" style={{ backgroundColor, color: foregroundColor }}>
      <div className="max-h-[calc(100vh-9rem)] overflow-auto font-mono text-[12px] leading-5" style={{ tabSize: 2 }}>
        {sections.map((section) => {
          const expanded = section.type === 'collapsed' && expandedSections.has(section.id)
          if (section.type === 'collapsed' && !expanded) {
            return <UnmodifiedLinesToggle key={section.id} count={section.lines.length} expanded={false} split={viewMode === 'split'} onClick={() => toggleSection(section.id)} />
          }
          return (
            <Fragment key={section.id}>
              {section.type === 'collapsed' && <UnmodifiedLinesToggle count={section.lines.length} expanded split={viewMode === 'split'} onClick={() => toggleSection(section.id)} />}
              {viewMode === 'split' ? (
                <SplitDiffLines
                  lines={section.lines}
                  oldTokens={oldTokens}
                  newTokens={newTokens}
                  gutterWidth={gutterWidth}
                  backgroundColor={backgroundColor}
                />
              ) : (
                <code className={cn('block', wrapLines ? 'min-w-full' : 'min-w-max')}>
                  {section.lines.map((line, index) => (
                    <DiffLineRow
                      key={`${line.type}-${line.oldLine ?? ''}-${line.newLine ?? ''}-${index}`}
                      line={line}
                      tokens={line.type === 'removed'
                        ? oldTokens.get(line.oldLine ?? -1) ?? []
                        : newTokens.get(line.newLine ?? -1) ?? []}
                      gutterWidth={gutterWidth}
                      backgroundColor={backgroundColor}
                      wrapLines={wrapLines}
                    />
                  ))}
                </code>
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

function UnmodifiedLinesToggle({ count, expanded, split = false, onClick }: {
  count: number
  expanded: boolean
  split?: boolean
  onClick: () => void
}) {
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="my-0.5 h-7 w-full justify-start gap-2 rounded-md bg-[var(--lume-bg-elevated)] px-3 font-sans text-[11px] font-normal text-[var(--lume-text-muted)] hover:bg-[color:color-mix(in_oklab,var(--lume-text-primary)_5%,var(--lume-bg-elevated))] hover:text-[var(--lume-text-secondary)]"
        onClick={onClick}
        aria-expanded={expanded}
      >
        <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
        <span>{expanded ? '收起' : `${count} 行未修改`}</span>
      </Button>
      {split && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 border-l border-[var(--lume-border-subtle)]" />}
    </div>
  )
}

function DiffLineRow({ line, tokens, gutterWidth, backgroundColor, wrapLines }: {
  line: CodingDiffLine
  tokens: HighlightToken[]
  gutterWidth: string
  backgroundColor: string
  wrapLines: boolean
}) {
  const gutterBackgroundColor = line.type === 'added'
    ? `color-mix(in oklab, var(--lume-success) 16%, ${backgroundColor})`
    : line.type === 'removed'
      ? `color-mix(in oklab, var(--lume-danger) 16%, ${backgroundColor})`
      : backgroundColor
  return (
    <div
      className={cn(
        'flex min-h-5 min-w-full border-l-2',
        wrapLines ? 'w-full' : 'w-max',
        line.type === 'added' ? 'border-[color:color-mix(in_oklab,var(--lume-success)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-success)_16%,var(--lume-bg-app))] text-[var(--lume-text-primary)]' :
          line.type === 'removed' ? 'border-[color:color-mix(in_oklab,var(--lume-danger)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-danger)_16%,var(--lume-bg-app))] text-[var(--lume-text-primary)]' : 'border-transparent text-[var(--lume-text-secondary)]',
      )}
    >
      <span
        aria-hidden
        className={cn('sticky left-0 shrink-0 select-none border-r border-current/10 pr-1.5 text-right opacity-45', line.type === 'added' && 'text-[var(--lume-success)]', line.type === 'removed' && 'text-[var(--lume-danger)]')}
        style={{ width: gutterWidth, backgroundColor: gutterBackgroundColor }}
      >
        {line.type === 'removed' ? line.oldLine ?? '' : line.newLine ?? line.oldLine ?? ''}
      </span>
      <DiffSyntaxLine line={line} tokens={tokens} wrapLines={wrapLines} />
    </div>
  )
}

interface SplitDiffRow {
  oldLine?: CodingDiffLine
  newLine?: CodingDiffLine
}

export function buildSplitDiffRows(lines: CodingDiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let cursor = 0

  while (cursor < lines.length) {
    const line = lines[cursor]!
    if (line.type === 'context') {
      rows.push({ oldLine: line, newLine: line })
      cursor += 1
      continue
    }

    const changed: CodingDiffLine[] = []
    while (cursor < lines.length && lines[cursor]?.type !== 'context') {
      changed.push(lines[cursor]!)
      cursor += 1
    }
    const removed = changed.filter((item) => item.type === 'removed')
    const added = changed.filter((item) => item.type === 'added')
    const rowCount = Math.max(removed.length, added.length)
    for (let index = 0; index < rowCount; index += 1) {
      rows.push({ oldLine: removed[index], newLine: added[index] })
    }
  }

  return rows
}

function SplitDiffLines({ lines, oldTokens, newTokens, gutterWidth, backgroundColor }: {
  lines: CodingDiffLine[]
  oldTokens: Map<number, HighlightToken[]>
  newTokens: Map<number, HighlightToken[]>
  gutterWidth: string
  backgroundColor: string
}) {
  const rows = useMemo(() => buildSplitDiffRows(lines), [lines])
  return (
    <div className="grid min-w-0 grid-cols-2">
      <code className="block min-w-0 overflow-x-auto overflow-y-hidden border-r border-[var(--lume-border-subtle)]">
        {rows.map((row, index) => (
          <SplitDiffCell
            key={`old-${row.oldLine?.oldLine ?? ''}-${row.newLine?.newLine ?? ''}-${index}`}
            line={row.oldLine}
            side="old"
            tokens={row.oldLine ? oldTokens.get(row.oldLine.oldLine ?? -1) ?? [] : []}
            gutterWidth={gutterWidth}
            backgroundColor={backgroundColor}
            wrapLines={false}
          />
        ))}
      </code>
      <code className="block min-w-0 overflow-x-auto overflow-y-hidden">
        {rows.map((row, index) => (
          <SplitDiffCell
            key={`new-${row.oldLine?.oldLine ?? ''}-${row.newLine?.newLine ?? ''}-${index}`}
            line={row.newLine}
            side="new"
            tokens={row.newLine ? newTokens.get(row.newLine.newLine ?? -1) ?? [] : []}
            gutterWidth={gutterWidth}
            backgroundColor={backgroundColor}
            wrapLines={false}
          />
        ))}
      </code>
    </div>
  )
}

function SplitDiffCell({ line, side, tokens, gutterWidth, backgroundColor, wrapLines }: {
  line?: CodingDiffLine
  side: 'old' | 'new'
  tokens: HighlightToken[]
  gutterWidth: string
  backgroundColor: string
  wrapLines: boolean
}) {
  const gutterBackgroundColor = line?.type === 'added'
    ? `color-mix(in oklab, var(--lume-success) 16%, ${backgroundColor})`
    : line?.type === 'removed'
      ? `color-mix(in oklab, var(--lume-danger) 16%, ${backgroundColor})`
      : backgroundColor

  return (
    <span
      className={cn(
        'flex min-h-5 min-w-full w-max border-l-2',
        !line && 'border-l-transparent',
        line?.type === 'added' && 'border-l-[color:color-mix(in_oklab,var(--lume-success)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-success)_16%,var(--lume-bg-app))] text-[var(--lume-text-primary)]',
        line?.type === 'removed' && 'border-l-[color:color-mix(in_oklab,var(--lume-danger)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-danger)_16%,var(--lume-bg-app))] text-[var(--lume-text-primary)]',
        line?.type === 'context' && 'border-l-transparent text-[var(--lume-text-secondary)]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'sticky left-0 shrink-0 select-none border-r border-current/10 pr-1.5 text-right opacity-45',
          line?.type === 'added' && 'text-[var(--lume-success)]',
          line?.type === 'removed' && 'text-[var(--lume-danger)]',
        )}
        style={{ width: gutterWidth, backgroundColor: gutterBackgroundColor }}
      >
        {line ? (side === 'old' ? line.oldLine ?? '' : line.newLine ?? '') : ''}
      </span>
      {line
        ? <DiffSyntaxLine line={line} tokens={tokens} wrapLines={wrapLines} />
        : <span className={cn('pl-2 pr-3', wrapLines ? 'min-w-0' : 'min-w-max')} />}
    </span>
  )
}

export function buildFullDiffSections(
  hunkLines: CodingDiffLine[],
  oldContent: string,
  newContent: string,
): FullDiffSection[] {
  const oldLines = splitDiffContent(oldContent)
  const newLines = splitDiffContent(newContent)
  const fullLines: CodingDiffLine[] = []
  let oldCursor = 1
  let newCursor = 1

  const appendGap = (oldTarget: number, newTarget: number) => {
    const oldGap = oldTarget - oldCursor
    const newGap = newTarget - newCursor
    if (oldGap <= 0 || oldGap !== newGap) return
    for (let offset = 0; offset < oldGap; offset += 1) {
      fullLines.push({
        type: 'context',
        oldLine: oldCursor + offset,
        newLine: newCursor + offset,
        text: newLines[newCursor + offset - 1] ?? oldLines[oldCursor + offset - 1] ?? '',
      })
    }
    oldCursor = oldTarget
    newCursor = newTarget
  }

  for (const line of hunkLines) {
    appendGap(line.oldLine ?? oldCursor, line.newLine ?? newCursor)
    fullLines.push(line)
    if (line.type !== 'added') oldCursor = (line.oldLine ?? oldCursor) + 1
    if (line.type !== 'removed') newCursor = (line.newLine ?? newCursor) + 1
  }
  appendGap(oldLines.length + 1, newLines.length + 1)

  if (hunkLines.length === 0 && oldContent === newContent && fullLines.length === 0) {
    for (let index = 0; index < newLines.length; index += 1) {
      fullLines.push({ type: 'context', oldLine: index + 1, newLine: index + 1, text: newLines[index] ?? '' })
    }
  }

  return collapseUnmodifiedRuns(fullLines)
}

function collapseUnmodifiedRuns(lines: CodingDiffLine[]): FullDiffSection[] {
  const sections: FullDiffSection[] = []
  let cursor = 0
  let sectionIndex = 0
  const pushLines = (items: CodingDiffLine[]) => {
    if (items.length === 0) return
    const previous = sections.at(-1)
    if (previous?.type === 'lines') previous.lines.push(...items)
    else sections.push({ type: 'lines', id: `lines-${sectionIndex++}`, lines: [...items] })
  }
  const pushCollapsed = (items: CodingDiffLine[]) => {
    if (items.length === 0) return
    const first = items[0]
    const last = items.at(-1)
    sections.push({
      type: 'collapsed',
      id: `collapsed-${first?.oldLine ?? first?.newLine ?? sectionIndex}-${last?.oldLine ?? last?.newLine ?? sectionIndex}`,
      lines: items,
    })
    sectionIndex += 1
  }

  while (cursor < lines.length) {
    if (lines[cursor]?.type !== 'context') {
      pushLines([lines[cursor]!])
      cursor += 1
      continue
    }
    const start = cursor
    while (cursor < lines.length && lines[cursor]?.type === 'context') cursor += 1
    const run = lines.slice(start, cursor)
    const hasChangeBefore = start > 0
    const hasChangeAfter = cursor < lines.length
    const keepStart = hasChangeBefore ? Math.min(DIFF_CONTEXT_LINES, run.length) : 0
    const keepEnd = hasChangeAfter ? Math.min(DIFF_CONTEXT_LINES, run.length - keepStart) : 0
    pushLines(run.slice(0, keepStart))
    pushCollapsed(run.slice(keepStart, run.length - keepEnd))
    pushLines(run.slice(run.length - keepEnd))
  }

  return sections
}

function createFallbackDiffLines(oldContent: string, newContent: string): CodingDiffLine[] {
  const oldLines = splitDiffContent(oldContent)
  const newLines = splitDiffContent(newContent)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1

  const lines: CodingDiffLine[] = []
  for (let index = 0; index < prefix; index += 1) lines.push({ type: 'context', oldLine: index + 1, newLine: index + 1, text: oldLines[index] ?? '' })
  for (let index = prefix; index < oldLines.length - suffix; index += 1) lines.push({ type: 'removed', oldLine: index + 1, text: oldLines[index] ?? '' })
  for (let index = prefix; index < newLines.length - suffix; index += 1) lines.push({ type: 'added', newLine: index + 1, text: newLines[index] ?? '' })
  for (let index = Math.max(prefix, oldLines.length - suffix); index < oldLines.length; index += 1) {
    const newIndex = newLines.length - oldLines.length + index
    lines.push({ type: 'context', oldLine: index + 1, newLine: newIndex + 1, text: oldLines[index] ?? '' })
  }
  return lines
}

function splitDiffContent(content: string): string[] {
  if (!content) return []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function countDiffContentLines(content: string): number {
  if (!content) return 0
  let count = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) count += 1
  }
  return content.endsWith('\n') ? count - 1 : count
}

function DiffSyntaxLine({ line, tokens, wrapLines }: { line: CodingDiffLine; tokens: HighlightToken[]; wrapLines: boolean }) {
  const tokenLength = tokens.reduce((sum, token) => sum + token.content.length, 0)
  return (
    <span className={cn('pl-2 pr-3', wrapLines ? 'min-w-0 whitespace-pre-wrap break-words' : 'min-w-max whitespace-pre')}>
      {tokens.map((token, index) => <span key={index} style={token.color ? { color: token.color } : undefined}>{token.content}</span>)}
      {tokenLength < line.text.length && line.text.slice(tokenLength)}
      {line.text.length === 0 && ' '}
    </span>
  )
}
