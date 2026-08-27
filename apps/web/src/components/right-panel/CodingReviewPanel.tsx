import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { CaseSensitive, Check, ChevronDown, ChevronRight, Columns2, Copy, ExternalLink, EyeOff, FileSearch, FileText, Folder, FolderOpen, GitCommitHorizontal, Image, ListChevronsDownUp, ListChevronsUpDown, Loader2, MessageSquareText, MoreHorizontal, RefreshCw, Search, Undo2, Upload, WrapText, type LucideIcon } from 'lucide-react'
import type {
  AgentDiffCommentAttachment,
  CodingDiffActionInput,
  CodingRunRevertInput,
  CodingRunRevertResult,
  CodingFileRevertInput,
  CodingFileRevertResult,
  CodingFileOpenTargets,
  CodingRepositoryPublishActionInput,
  CodingRepositoryPublishActionResult,
  CodingRepositoryPublishState,
  CodingReviewSearchInput,
  CodingReviewSearchMatch,
  CodingReviewSearchResult,
  CodingReviewSource as WorkspaceCodingReviewSource,
  CodingReviewSourcesResult,
  CodingReviewStageFilter,
  RuntimeCodingChangeSet,
  RuntimeCodingFileChange,
} from '@lume/shared'
import { AGENT_IPC_CHANNELS, formatCodingFileRevertNotice, formatCodingRevertSummary } from '@lume/shared'
import type { DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs'
import { Virtualizer } from '@pierre/diffs/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { PierreDiffView, createPierreFileDiff } from '@/components/diff/PierreDiffView'
import { CodingRichDiffPreview } from './CodingRichDiffPreview'
import {
  readSessionCodingDiff,
  removeSessionCodingDiff,
  requestSessionCodingDiff,
  type CodingDiffPayload,
} from '@/components/right-panel/coding-diff-cache'
import { agentDiffCommentDraftsAtom, agentDiffCommentDraftsFamily, agentRuntimeEventsFamily } from '@/atoms'
import {
  codingReviewFileKey,
  codingReviewPreferencesAtom,
  codingReviewScrollPositionsAtom,
  codingReviewStatusActionAtom,
  codingReviewStatusAtom,
  type CodingReviewPanelState,
} from '@/atoms/right-panel-atoms'
import { openExternal, openInSystem, revealPathInSystem, sidecarCall, writeClipboardText } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'

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

export function buildGitApplyCommand(patches: string[]): string {
  const patch = patches
    .map((value) => value.replace(/\r\n?/g, '\n').trimEnd())
    .filter(Boolean)
    .join('\n')
  if (!patch) return ''
  return `(cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF'\n${patch}\nEOF\n)`
}

export const REVIEW_DIFF_CONTEXT_OPTIONS = {
  expandUnchanged: false,
  collapsedContextThreshold: 1,
  expansionLineCount: 20,
} as const

const REVIEW_CAPPED_FILE_COUNT = 128
const REVIEW_CAPPED_CHANGED_LINES = 9_000
const REVIEW_FILE_CHANGED_LINES_LIMIT = 15_000
const REVIEW_FILE_CHANGED_BYTES_LIMIT = 3 * 1024 * 1024
const REVIEW_FILE_LINE_BYTES_LIMIT = 1024 * 1024

export function isReviewFileTooLarge(review: Extract<CodingDiffPayload, { kind: 'text' }>): boolean {
  if (review.addedLines + review.removedLines > REVIEW_FILE_CHANGED_LINES_LIMIT) return true
  const encoder = new TextEncoder()
  let changedBytes = 0
  let maxChangedLineBytes = 0
  for (const line of review.patch.replace(/\r\n?/g, '\n').split('\n')) {
    if ((!line.startsWith('+') && !line.startsWith('-')) || line.startsWith('+++') || line.startsWith('---')) continue
    const lineBytes = encoder.encode(line.slice(1)).byteLength
    changedBytes += lineBytes
    maxChangedLineBytes = Math.max(maxChangedLineBytes, lineBytes)
    if (changedBytes > REVIEW_FILE_CHANGED_BYTES_LIMIT || maxChangedLineBytes > REVIEW_FILE_LINE_BYTES_LIMIT) return true
  }
  return false
}

type CodingPublishAction = CodingRepositoryPublishActionInput['action']
type AvailableCodingPublishState = Extract<CodingRepositoryPublishState, { available: true }>

export function codingPublishActionDisabledReason(
  state: AvailableCodingPublishState,
  action: CodingPublishAction,
  options: {
    commitMessage: string
    includeUnstagedChanges: boolean
    busy?: boolean
  },
): string | undefined {
  if (options.busy) return '正在处理 Git 操作'
  if (action === 'push') {
    if (!state.canPush) return '当前分支没有可用的远程推送目标'
    if (state.ahead <= 0) return '没有待推送的本地提交'
    return undefined
  }
  if (options.includeUnstagedChanges && state.worktreeHash === undefined) {
    // worktree patch 超 16MB 水位时指纹缺席（见 shared 类型 worktreeHash 注释）
    return '工作区变更超过 16MB 补丁上限，请分次提交'
  }
  const includedChanges = options.includeUnstagedChanges
    ? state.unstagedCount + state.untrackedCount
    : 0
  if (!state.canCommit && includedChanges === 0) {
    return state.unstagedCount + state.untrackedCount > 0
      ? '请先 Stage 变更，或选择包含未暂存的变更'
      : '没有可提交的变更'
  }
  if (!options.commitMessage.trim()) return '请输入提交消息'
  if (action === 'commit_and_push' && !state.canPush) {
    return '当前分支没有可用的远程推送目标'
  }
  return undefined
}

type CodingReviewSource = { kind: 'last-turn' } | WorkspaceCodingReviewSource

const LAST_TURN_SOURCE = { kind: 'last-turn' } as const
const UNCOMMITTED_SOURCE = { kind: 'uncommitted' } as const

function codingReviewSourceKey(source: CodingReviewSource): string {
  if (source.kind === 'branch') return `branch:${source.baseRef}`
  if (source.kind === 'commit') return `commit:${source.commitSha}`
  return source.kind
}

function codingReviewSourceLabel(source: CodingReviewSource): string {
  if (source.kind === 'last-turn') return '最新轮次'
  if (source.kind === 'uncommitted') return '未提交'
  if (source.kind === 'unstaged') return '未暂存'
  if (source.kind === 'staged') return '已暂存'
  if (source.kind === 'commit') return '已提交'
  return '分支'
}

function codingReviewSourceDetail(source: CodingReviewSource, sources: CodingReviewSourcesResult | null): string | undefined {
  if (source.kind === 'branch') return source.baseRef
  if (source.kind === 'commit') {
    return sources?.commits.find((commit) => commit.sha === source.commitSha)?.subject
      ?? source.commitSha.slice(0, 8)
  }
  return undefined
}

function diffStateKey(source: CodingReviewSource, runId: string | undefined, change: Pick<RuntimeCodingFileChange, 'path' | 'rootId'>): string {
  const sourceKey = source.kind === 'last-turn' ? `session:${runId ?? ''}` : codingReviewSourceKey(source)
  return `${sourceKey}:${codingReviewFileKey(change)}`
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
  const [activeSource, setActiveSource] = useState<CodingReviewSource>(LAST_TURN_SOURCE)
  const [availableSources, setAvailableSources] = useState<CodingReviewSourcesResult | null>(null)
  const [workspaceChanges, setWorkspaceChanges] = useState<RuntimeCodingFileChange[]>([])
  const [workspaceIsGitRepo, setWorkspaceIsGitRepo] = useState(false)
  const [reviews, setReviews] = useState<Record<string, CodingDiffPayload>>({})
  const [loadingDiffs, setLoadingDiffs] = useState<Set<string>>(() => new Set())
  const [diffErrors, setDiffErrors] = useState<Record<string, string>>({})
  const [diffActionPending, setDiffActionPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [diffRequestKey, setDiffRequestKey] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpQuery, setJumpQuery] = useState('')
  const [reviewSearchResult, setReviewSearchResult] = useState<CodingReviewSearchResult | null>(null)
  const [reviewSearchLoading, setReviewSearchLoading] = useState(false)
  const [reviewSearchError, setReviewSearchError] = useState<string | null>(null)
  const [reviewSearchLimit, setReviewSearchLimit] = useState(100)
  const [reviewPreferences, setReviewPreferences] = useAtom(codingReviewPreferencesAtom)
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
  const [treeQuery, setTreeQuery] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [activeDiffPath, setActiveDiffPath] = useState(selectedChangeKey(state))
  const [revertBusy, setRevertBusy] = useState(false)
  const [fileRevertBusyPath, setFileRevertBusyPath] = useState<string | null>(null)
  const [revertNotice, setRevertNotice] = useState<string | null>(null)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishState, setPublishState] = useState<CodingRepositoryPublishState | null>(null)
  const [publishBusy, setPublishBusy] = useState(false)
  const [publishPendingAction, setPublishPendingAction] = useState<CodingPublishAction | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [includeUnstagedChanges, setIncludeUnstagedChanges] = useState(false)
  const localDiffCache = useRef(new Map<string, CodingDiffPayload>())
  const localDiffRequests = useRef(new Map<string, Promise<CodingDiffPayload>>())
  const localDiffGeneration = useRef(0)
  const fileRowRefs = useRef(new Map<string, HTMLDivElement>())
  const reviewViewportHostRef = useRef<HTMLDivElement>(null)
  const [scrollPositions, setScrollPositions] = useAtom(codingReviewScrollPositionsAtom)
  const reviewStatus = useAtomValue(codingReviewStatusAtom)[threadId]
  const reviewStatusAction = useSetAtom(codingReviewStatusActionAtom)
  const workspaceReviewSource: WorkspaceCodingReviewSource = activeSource.kind === 'last-turn' ? UNCOMMITTED_SOURCE : activeSource
  const workspaceStageFilter = activeSource.kind === 'uncommitted'
    || activeSource.kind === 'unstaged'
    || activeSource.kind === 'staged'
    ? activeSource.kind
    : null
  const activeSourceKey = codingReviewSourceKey(activeSource)
  const reviewScrollKey = `${threadId}:${activeSourceKey}`
  const isWorkspaceSource = activeSource.kind !== 'last-turn'
  const wrapDiffLines = reviewPreferences.wrapLines
  const omitFullFile = reviewPreferences.omitFullFile
  const richPreviewEnabled = reviewPreferences.richPreview
  const wordDiffsEnabled = reviewPreferences.wordDiffs
  const hideWhitespace = reviewPreferences.hideWhitespace
  const diffViewMode = reviewPreferences.viewMode
  const visibleChanges = isWorkspaceSource ? workspaceChanges : state.changes
  const jumpChanges = visibleChanges.filter((change) => change.path.toLowerCase().includes(jumpQuery.trim().toLowerCase()))
  const reviewSearchFiles = useMemo(
    () => visibleChanges.map((change) => ({ path: change.path, rootId: change.rootId })),
    [visibleChanges],
  )
  const fileTree = useMemo(
    () => buildDiffFileTree(visibleChanges
      .filter((change) => change.path.toLowerCase().includes(treeQuery.trim().toLowerCase()))
      .map((change) => change.path)),
    [treeQuery, visibleChanges],
  )
  const totalAdded = visibleChanges.reduce((sum, change) => sum + (change.addedLines ?? 0), 0)
  const totalRemoved = visibleChanges.reduce((sum, change) => sum + (change.removedLines ?? 0), 0)
  const isCappedMode = visibleChanges.length > REVIEW_CAPPED_FILE_COUNT
    || totalAdded + totalRemoved > REVIEW_CAPPED_CHANGED_LINES
  const cappedActiveChange = visibleChanges.find((change) => codingReviewFileKey(change) === activeDiffPath) ?? visibleChanges[0]
  const renderedChanges = isCappedMode ? (cappedActiveChange ? [cappedActiveChange] : []) : visibleChanges
  const allDiffsExpanded = renderedChanges.length > 0 && renderedChanges.every((change) => expandedPaths.has(codingReviewFileKey(change)))
  const workspaceRootIds = new Set(workspaceChanges.map((change) => change.rootId ?? ''))
  const reviewRootIds = new Set(visibleChanges.map((change) => change.rootId ?? ''))
  const hasSingleReviewRoot = reviewRootIds.size <= 1
  const canApplySectionAction = isWorkspaceSource && workspaceStageFilter !== null && workspaceIsGitRepo && workspaceChanges.length > 0 && workspaceRootIds.size === 1
  const sectionAction: 'stage' | 'unstage' = workspaceStageFilter === 'staged' ? 'unstage' : 'stage'
  const publishChange = workspaceChanges.find((change) => codingReviewFileKey(change) === activeDiffPath)
    ?? workspaceChanges.find((change) => change.path === visibleChanges.find((candidate) => codingReviewFileKey(candidate) === activeDiffPath)?.path)
    ?? workspaceChanges[0]
  const publishRootId = publishChange?.rootId ?? state.selectedRootId
  const preloadChanges = useMemo(
    () => state.changes
      .filter((change) => change.state !== 'unpreviewable' && (change.oldContentAvailable !== false || change.newContentAvailable !== false)),
    [state.changes],
  )

  const getCachedDiff = useCallback((change: Pick<RuntimeCodingFileChange, 'path' | 'rootId'>, source: CodingReviewSource) => {
    if (source.kind === 'last-turn' && state.runId) {
      return readSessionCodingDiff(threadId, state.runId, change.path, change.rootId)
    }
    return localDiffCache.current.get(diffStateKey(source, state.runId, change))
  }, [state.runId, threadId])

  const loadDiff = useCallback((change: Pick<RuntimeCodingFileChange, 'path' | 'rootId'>, source: CodingReviewSource) => {
    if (source.kind === 'last-turn' && state.runId) {
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
      ...(source.kind === 'last-turn'
        ? { runId: state.runId }
        : { reviewSource: source }),
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
    let cancelled = false
    void sidecarCall<RuntimeCodingChangeSet | RuntimeCodingFileChange[]>(AGENT_IPC_CHANNELS.GET_CODING_CHANGE_SET, {
      threadId,
      runId: state.runId,
      reviewSource: workspaceReviewSource,
    })
      .then((result) => {
        if (cancelled) return
        if (Array.isArray(result)) {
          setWorkspaceChanges(result)
          setWorkspaceIsGitRepo(false)
          return
        }
        setWorkspaceChanges(result.files ?? [])
        setWorkspaceIsGitRepo(result.isGitRepo)
      })
      .catch(() => {
        if (cancelled) return
        setWorkspaceChanges([])
        setWorkspaceIsGitRepo(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, state.runId, threadId, workspaceReviewSource])

  useEffect(() => {
    let cancelled = false
    void sidecarCall<CodingReviewSourcesResult>(AGENT_IPC_CHANNELS.GET_CODING_REVIEW_SOURCES, {
      threadId,
      runId: state.runId,
      rootId: state.selectedRootId,
    }).then((result) => {
      if (!cancelled) setAvailableSources(result)
    }).catch(() => {
      if (!cancelled) setAvailableSources(null)
    })
    return () => {
      cancelled = true
    }
  }, [refreshKey, state.runId, state.selectedRootId, threadId])

  useEffect(() => {
    if (!availableSources || activeSource.kind === 'last-turn' || activeSource.kind === 'uncommitted') return
    if (!hasSingleReviewRoot && (activeSource.kind === 'branch' || activeSource.kind === 'commit')) {
      setActiveSource(UNCOMMITTED_SOURCE)
      return
    }
    if (!availableSources.available) {
      setActiveSource(UNCOMMITTED_SOURCE)
      return
    }
    if (activeSource.kind === 'branch' && !availableSources.branches.includes(activeSource.baseRef)) {
      setActiveSource(UNCOMMITTED_SOURCE)
      return
    }
    if (activeSource.kind === 'commit' && !availableSources.commits.some((commit) => commit.sha === activeSource.commitSha)) {
      setActiveSource(UNCOMMITTED_SOURCE)
    }
  }, [activeSource, availableSources, hasSingleReviewRoot])

  useEffect(() => {
    const query = jumpQuery.trim()
    if (!jumpOpen || !query || reviewSearchFiles.length === 0) {
      setReviewSearchResult(null)
      setReviewSearchLoading(false)
      setReviewSearchError(null)
      return
    }
    if (activeSource.kind === 'last-turn' && !state.runId) {
      setReviewSearchResult({ matches: [], truncated: false })
      setReviewSearchLoading(false)
      setReviewSearchError('当前 Turn 没有可搜索的 Diff 快照')
      return
    }
    let cancelled = false
    setReviewSearchResult(null)
    setReviewSearchLoading(true)
    setReviewSearchError(null)
    const timer = window.setTimeout(() => {
      const input: CodingReviewSearchInput = {
        threadId,
        runId: state.runId,
        files: reviewSearchFiles,
        query,
        limit: reviewSearchLimit,
        ...(activeSource.kind === 'last-turn' ? {} : { reviewSource: workspaceReviewSource }),
      }
      void sidecarCall<CodingReviewSearchResult>(AGENT_IPC_CHANNELS.SEARCH_CODING_REVIEW, input)
        .then((result) => {
          if (!cancelled) setReviewSearchResult(result)
        })
        .catch((cause) => {
          if (!cancelled) {
            setReviewSearchResult({ matches: [], truncated: false })
            setReviewSearchError(cause instanceof Error ? cause.message : '无法搜索 Diff')
          }
        })
        .finally(() => {
          if (!cancelled) setReviewSearchLoading(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    activeSource.kind,
    activeSourceKey,
    jumpOpen,
    jumpQuery,
    reviewSearchFiles,
    reviewSearchLimit,
    state.runId,
    threadId,
    workspaceReviewSource,
  ])

  useEffect(() => {
    const selectedKey = selectedChangeKey(state)
    setExpandedPaths(new Set(selectedKey ? [selectedKey] : []))
    setActiveDiffPath(selectedKey)
  }, [state.selectedPath, state.selectedRootId])

  useEffect(() => {
    if (!isCappedMode || !cappedActiveChange) return
    const key = codingReviewFileKey(cappedActiveChange)
    setActiveDiffPath(key)
    setExpandedPaths((current) => current.has(key) ? current : new Set(current).add(key))
  }, [cappedActiveChange, isCappedMode])

  useEffect(() => {
    const viewport = reviewViewportHostRef.current?.querySelector<HTMLElement>('.coding-review-scrollbar')
    if (!viewport) return
    const savedPosition = scrollPositions[reviewScrollKey] ?? 0
    let saveTimer: number | undefined
    const restoreFrame = window.requestAnimationFrame(() => {
      viewport.scrollTop = Math.min(savedPosition, Math.max(0, viewport.scrollHeight - viewport.clientHeight))
    })
    const savePosition = () => {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        const scrollTop = viewport.scrollTop
        setScrollPositions((current) => current[reviewScrollKey] === scrollTop
          ? current
          : { ...current, [reviewScrollKey]: scrollTop })
      }, 150)
    }
    viewport.addEventListener('scroll', savePosition, { passive: true })
    return () => {
      window.cancelAnimationFrame(restoreFrame)
      window.clearTimeout(saveTimer)
      viewport.removeEventListener('scroll', savePosition)
      const scrollTop = viewport.scrollTop
      setScrollPositions((current) => current[reviewScrollKey] === scrollTop
        ? current
        : { ...current, [reviewScrollKey]: scrollTop })
    }
  }, [reviewScrollKey, setScrollPositions])

  useEffect(() => {
    const source = activeSource
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
  }, [activeSource, diffRequestKey, expandedPaths, getCachedDiff, loadDiff, state.runId, visibleChanges])

  useEffect(() => {
    if (!state.runId || preloadChanges.length === 0 || isCappedMode) return
    let cancelled = false
    const queue = preloadChanges.filter((change) => !getCachedDiff(change, LAST_TURN_SOURCE))
    const timer = window.setTimeout(() => {
      const worker = async () => {
        while (!cancelled) {
          const change = queue.shift()
          if (!change) return
          await loadDiff(change, LAST_TURN_SOURCE).catch(() => undefined)
        }
      }
      void Promise.all([worker(), worker()])
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [getCachedDiff, isCappedMode, loadDiff, preloadChanges, state.runId])

  const prefetchDiff = useCallback((change: RuntimeCodingFileChange) => {
    const source = activeSource
    if (getCachedDiff(change, source)) return
    void loadDiff(change, source).catch(() => undefined)
  }, [activeSource, getCachedDiff, loadDiff])

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
    const source = activeSource
    const key = diffStateKey(source, state.runId, change)
    if (source.kind === 'last-turn' && state.runId) removeSessionCodingDiff(threadId, state.runId, change.path, change.rootId)
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
      if (renderedChanges.every((change) => next.has(codingReviewFileKey(change)))) {
        for (const change of renderedChanges) next.delete(codingReviewFileKey(change))
      } else {
        for (const change of renderedChanges) next.add(codingReviewFileKey(change))
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

  const jumpToSearchMatch = (match: CodingReviewSearchMatch) => {
    const change = visibleChanges.find((candidate) => (
      candidate.path === match.path
      && (!match.rootId || candidate.rootId === match.rootId)
    ))
    if (change) jumpToDiff(change)
  }

  const switchChangeSource = (source: CodingReviewSource) => {
    if (codingReviewSourceKey(source) === activeSourceKey) return
    setActiveSource(source)
    if (source.kind !== 'last-turn') setWorkspaceChanges([])
    setExpandedPaths(new Set())
    setActiveDiffPath('')
    setTreeQuery('')
    setActionError(null)
    setRevertNotice(null)
  }

  const applyDiffAction = async (
    change: RuntimeCodingFileChange,
    review: CodingDiffPayload,
    action: CodingDiffActionInput['action'],
    hunkIndex?: number,
  ) => {
    setDiffActionPending(true)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.APPLY_CODING_DIFF_ACTION, {
        threadId,
        runId: state.runId,
        rootId: change.rootId,
        path: change.path,
        scope: hunkIndex === undefined ? 'file' : 'hunk',
        ...(hunkIndex === undefined ? {} : { hunkIndex }),
        action,
        ...(workspaceStageFilter ? { stageFilter: workspaceStageFilter } : {}),
        expectedDiffHash: review.diffHash,
      } satisfies CodingDiffActionInput)
      refreshDiffs()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '无法应用 Diff 操作')
    } finally {
      setDiffActionPending(false)
    }
  }

  const runRevertible = state.phase !== 'executing' && state.phase !== 'verifying'
  // 行级快照撤销仅在「最新轮次」源可用：工作区源没有 Run 快照语义
  const fileRevertible = activeSource.kind === 'last-turn' && Boolean(state.runId) && runRevertible

  const revertRunChanges = async () => {
    if (!state.runId || revertBusy || !runRevertible) return
    if (!window.confirm('将本次 Run 写过的文件还原到改动前快照？被还原的未提交改动将被丢弃且无法找回（新建文件会被删除）；已提交与外部修改过的文件不会被覆盖。')) return
    setRevertBusy(true)
    setRevertNotice(null)
    try {
      const result = await sidecarCall<CodingRunRevertResult>(
        AGENT_IPC_CHANNELS.REVERT_CODING_RUN,
        { threadId, runId: state.runId } satisfies CodingRunRevertInput,
      )
      setRevertNotice(formatCodingRevertSummary(result))
      toast.success(`已撤销本次 Run 的文件改动`)
      refreshDiffs()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '无法撤销本次改动')
    } finally {
      setRevertBusy(false)
    }
  }

  const revertFileChange = async (change: RuntimeCodingFileChange) => {
    if (!state.runId || !fileRevertible || fileRevertBusyPath) return
    if (!window.confirm(`将 ${change.path} 还原到本次 Run 改动前快照？未提交改动将被丢弃且无法找回；已提交与外部修改过的文件不会被覆盖。`)) return
    const fileKey = codingReviewFileKey(change)
    setFileRevertBusyPath(fileKey)
    setRevertNotice(null)
    try {
      const result = await sidecarCall<CodingFileRevertResult>(
        AGENT_IPC_CHANNELS.REVERT_CODING_FILE,
        { threadId, runId: state.runId, path: change.path, rootId: change.rootId } satisfies CodingFileRevertInput,
      )
      const notice = formatCodingFileRevertNotice(result)
      if (notice) {
        setRevertNotice(notice)
        toast.error(notice)
      } else {
        toast.success('已撤销该文件的改动')
      }
      refreshDiffs()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法撤销该文件的改动')
    } finally {
      setFileRevertBusyPath(null)
    }
  }

  const loadWorkspaceDiffs = async (): Promise<CodingDiffPayload[]> => {
    const queue = visibleChanges.map((change, index) => ({ change, index }))
    const payloads = new Array<CodingDiffPayload>(visibleChanges.length)
    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) return
        payloads[item.index] = await loadDiff(item.change, workspaceReviewSource)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
    return payloads
  }

  const copyGitApplyCommand = async () => {
    if (!isWorkspaceSource) {
      toast.error('请切换到工作区变更后再复制 git apply 命令')
      return
    }
    try {
      const payloads = await loadWorkspaceDiffs()
      const textPayloads = payloads.filter((payload): payload is Extract<CodingDiffPayload, { kind: 'text' }> => payload.kind === 'text')
      if (textPayloads.length !== payloads.length) {
        throw new Error('当前变更包含媒体或二进制文件，无法生成纯文本 git apply 命令')
      }
      const command = buildGitApplyCommand(textPayloads.map((payload) => payload.patch))
      if (!command) throw new Error('当前没有可复制的文本 Diff')
      await writeClipboardText(command)
      toast.success('已复制 git apply 命令')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '复制 git apply 命令失败')
    }
  }

  const applySectionAction = async (action: 'stage' | 'unstage') => {
    if (!canApplySectionAction) {
      setActionError(workspaceRootIds.size > 1 ? '多仓库变更不能作为一个原子分区操作' : '请切换到工作区变更')
      return
    }
    setDiffActionPending(true)
    try {
      const payloads = await loadWorkspaceDiffs()
      const targets = payloads.filter((payload) => action === 'stage' ? payload.actions.canStage : payload.actions.canUnstage)
      if (targets.length === 0) {
        throw new Error(action === 'stage' ? '没有可 Stage 的变更' : '没有可 Unstage 的变更')
      }
      await sidecarCall(AGENT_IPC_CHANNELS.APPLY_CODING_DIFF_ACTION, {
        threadId,
        runId: state.runId,
        rootId: workspaceChanges[0]?.rootId,
        scope: 'section',
        action,
        stageFilter: workspaceStageFilter!,
        files: targets.map((payload) => ({
          path: payload.path,
          expectedDiffHash: payload.diffHash,
        })),
      } satisfies CodingDiffActionInput)
      refreshDiffs()
      toast.success(action === 'stage' ? '已 Stage 全部变更' : '已 Unstage 全部变更')
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '无法应用分区级 Git 操作')
    } finally {
      setDiffActionPending(false)
    }
  }

  const loadPublishState = async () => {
    setPublishState(null)
    setPublishError(null)
    try {
      const result = await sidecarCall<CodingRepositoryPublishState>(
        AGENT_IPC_CHANNELS.GET_CODING_REPOSITORY_PUBLISH_STATE,
        {
          threadId,
          runId: state.runId,
          rootId: publishRootId,
        },
      )
      setPublishState(result)
    } catch (cause) {
      setPublishError(cause instanceof Error ? cause.message : '无法读取仓库提交状态')
    }
  }

  const applyPublishAction = async (action: CodingRepositoryPublishActionInput['action']) => {
    if (!publishState?.available) return
    const disabledReason = codingPublishActionDisabledReason(publishState, action, {
      commitMessage,
      includeUnstagedChanges,
    })
    if (disabledReason) {
      setPublishError(disabledReason)
      return
    }
    setPublishBusy(true)
    setPublishPendingAction(action)
    setPublishError(null)
    try {
      const input: CodingRepositoryPublishActionInput = action === 'push'
        ? {
            threadId,
            runId: state.runId,
            rootId: publishState.rootId,
            action,
            expectedBranch: publishState.branch,
            expectedHead: publishState.head,
          }
        : {
            threadId,
            runId: state.runId,
            rootId: publishState.rootId,
            action,
            message: commitMessage.trim(),
            expectedBranch: publishState.branch,
            expectedHead: publishState.head,
            expectedIndexHash: publishState.indexHash,
            ...(includeUnstagedChanges ? {
              includeUnstagedChanges: true,
              expectedWorktreeHash: publishState.worktreeHash,
            } : {}),
          }
      const result = await sidecarCall<CodingRepositoryPublishActionResult>(
        AGENT_IPC_CHANNELS.APPLY_CODING_REPOSITORY_PUBLISH_ACTION,
        input,
      )
      setPublishState(result.state)
      refreshDiffs()
      if (result.error) {
        setPublishError(`提交已成功，但推送失败：${result.error}`)
        toast.error('提交已成功，但推送失败')
        return
      }
      setCommitMessage('')
      setIncludeUnstagedChanges(false)
      setPublishDialogOpen(false)
      const branch = result.state.available ? result.state.branch : publishState.branch
      toast.success(action === 'commit'
        ? `已提交到 ${branch}`
        : action === 'push'
          ? `已推送 ${branch}`
          : `已提交并推送 ${branch}`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '提交或推送失败'
      toast.error(message)
      await loadPublishState()
      setPublishError(message)
    } finally {
      setPublishBusy(false)
      setPublishPendingAction(null)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[var(--lume-bg-panel)] text-[var(--lume-text-primary)]" aria-label="Coding 变更审核">
      <header className="h-10 shrink-0 border-b border-[var(--lume-border-subtle)]">
        <div className="flex h-10 items-center gap-2 px-3">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-7 gap-1 px-1 text-[13px] font-medium text-[var(--lume-text-primary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]" />}>
              <span>{codingReviewSourceLabel(activeSource)}</span>
              {codingReviewSourceDetail(activeSource, availableSources) && (
                <span className="max-w-40 truncate text-[11px] font-normal text-[var(--lume-text-muted)]">
                  {codingReviewSourceDetail(activeSource, availableSources)}
                </span>
              )}
              <ChevronDown className="size-3.5 text-[var(--lume-text-muted)]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-52">
              <DropdownMenuItem onSelect={() => switchChangeSource(LAST_TURN_SOURCE)}>
                最新轮次
                {activeSource.kind === 'last-turn' && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => switchChangeSource(UNCOMMITTED_SOURCE)}>
                未提交
                {activeSource.kind === 'uncommitted' && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
              {workspaceIsGitRepo && (
                <>
                  <DropdownMenuItem onSelect={() => switchChangeSource({ kind: 'unstaged' })}>
                    未暂存
                    {activeSource.kind === 'unstaged' && <Check className="ml-auto size-3.5" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => switchChangeSource({ kind: 'staged' })}>
                    已暂存
                    {activeSource.kind === 'staged' && <Check className="ml-auto size-3.5" />}
                  </DropdownMenuItem>
                  {hasSingleReviewRoot && (availableSources?.commits.length ?? 0) > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>已提交</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="max-h-80 min-w-72 overflow-y-auto">
                          {availableSources!.commits.map((commit) => (
                            <DropdownMenuItem
                              key={commit.sha}
                              title={commit.subject}
                              onSelect={() => switchChangeSource({ kind: 'commit', commitSha: commit.sha })}
                            >
                              <span className="font-mono text-[10px] text-[var(--lume-text-muted)]">{commit.sha.slice(0, 8)}</span>
                              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                              {activeSource.kind === 'commit' && activeSource.commitSha === commit.sha && <Check className="ml-auto size-3.5" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </>
                  )}
                  {hasSingleReviewRoot && (availableSources?.branches.length ?? 0) > 0 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>分支</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-80 min-w-56 overflow-y-auto">
                        {availableSources!.branches.map((branch) => (
                          <DropdownMenuItem
                            key={branch}
                            onSelect={() => switchChangeSource({ kind: 'branch', baseRef: branch })}
                          >
                            <span className="min-w-0 flex-1 truncate">{branch}</span>
                            {activeSource.kind === 'branch' && activeSource.baseRef === branch && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="text-[12px] tabular-nums text-[var(--lume-success)]">+{totalAdded}</span>
          <span className="text-[12px] tabular-nums text-[var(--lume-danger)]">-{totalRemoved}</span>
          <div className="ml-auto flex min-w-0 items-center gap-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]" title="更多选项" aria-label="更多审阅选项" />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-52">
                <DropdownMenuItem onSelect={refreshDiffs}><RefreshCw className="size-3.5" />刷新</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setReviewPreferences((current) => ({ ...current, wrapLines: !current.wrapLines }))}>
                  <WrapText className="size-3.5" />{wrapDiffLines ? '禁用自动换行' : '启用自动换行'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setReviewPreferences((current) => ({ ...current, omitFullFile: !current.omitFullFile }))}>
                  <FileText className="size-3.5" />{omitFullFile ? '加载完整文件' : '不加载完整文件'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setReviewPreferences((current) => ({ ...current, richPreview: !current.richPreview }))}>
                  <Image className="size-3.5" />{richPreviewEnabled ? '禁用富文本预览' : '启用富文本预览'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setReviewPreferences((current) => ({ ...current, wordDiffs: !current.wordDiffs }))}>
                  <CaseSensitive className="size-3.5" />{wordDiffsEnabled ? '禁用文字差异' : '启用文字差异'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setReviewPreferences((current) => ({ ...current, hideWhitespace: !current.hideWhitespace }))}>
                  <EyeOff className="size-3.5" />{hideWhitespace ? '显示空白字符' : '隐藏空白字符'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!isWorkspaceSource || visibleChanges.length === 0}
                  title={!isWorkspaceSource ? '历史 Run Diff 可能已过期，请切换到工作区变更' : undefined}
                  onSelect={() => void copyGitApplyCommand()}
                >
                  <Copy className="size-3.5" />复制 git apply 命令
                </DropdownMenuItem>
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
              if (!open) {
                setJumpQuery('')
                setReviewSearchLimit(100)
              }
            }}>
              <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className={cn('text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]', jumpOpen && 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)]')} title="搜索 Diff" aria-label="搜索 Diff" />}>
                <FileSearch />
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" sideOffset={6} className="w-[min(28rem,calc(100vw-2rem))]">
                <div className="flex h-9 items-center gap-2 border-b border-[var(--lume-border-subtle)] px-2.5">
                  <Search className="size-3.5 shrink-0 text-[var(--lume-text-muted)]" />
                  <Input
                    autoFocus
                    value={jumpQuery}
                    onChange={(event) => {
                      setJumpQuery(event.target.value)
                      setReviewSearchLimit(100)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      if (jumpQuery.trim()) {
                        const match = reviewSearchResult?.matches[0]
                        if (match) jumpToSearchMatch(match)
                      } else if (jumpChanges[0]) {
                        jumpToDiff(jumpChanges[0])
                      }
                    }}
                    placeholder="搜索文件名或 Diff 内容"
                    aria-label="搜索文件名或 Diff 内容"
                    className="h-8 flex-1 border-0 bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto p-1">
                  {!jumpQuery.trim() && jumpChanges.map((change) => (
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
                  {jumpQuery.trim() && reviewSearchResult?.matches.map((match, index) => {
                    const change = visibleChanges.find((candidate) => candidate.path === match.path
                      && (!match.rootId || candidate.rootId === match.rootId))
                    return (
                      <Button
                        key={`${match.rootId ?? ''}:${match.path}:${match.kind}:${match.side ?? ''}:${match.lineNumber ?? ''}:${index}`}
                        variant="ghost"
                        size="sm"
                        disabled={!change}
                        className="h-auto min-h-9 w-full items-start justify-start gap-2 px-2 py-1.5 text-left text-[12px] font-normal text-[var(--lume-text-secondary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
                        onPointerEnter={() => change && prefetchDiff(change)}
                        onFocus={() => change && prefetchDiff(change)}
                        onClick={() => jumpToSearchMatch(match)}
                      >
                        <DiffSearchMatchLabel match={match} />
                      </Button>
                    )
                  })}
                  {reviewSearchLoading && (
                    <div className="flex items-center justify-center gap-2 px-2 py-3 text-[12px] text-[var(--lume-text-muted)]">
                      <Loader2 className="size-3.5 animate-spin" />正在搜索全部 Diff…
                    </div>
                  )}
                  {jumpQuery.trim() && !reviewSearchLoading && reviewSearchError && (
                    <div className="px-2 py-3 text-center text-[12px] text-[var(--lume-danger)]">{reviewSearchError}</div>
                  )}
                  {jumpQuery.trim() && !reviewSearchLoading && !reviewSearchError && reviewSearchResult?.matches.length === 0 && (
                    <div className="px-2 py-4 text-center text-[12px] text-[var(--lume-text-muted)]">Diff 中没有匹配内容</div>
                  )}
                  {jumpQuery.trim() && reviewSearchResult?.truncated && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-full justify-center text-[12px] text-[var(--lume-text-secondary)]"
                      disabled={reviewSearchLoading || reviewSearchLimit >= 500}
                      onClick={() => setReviewSearchLimit((current) => Math.min(500, current + 100))}
                    >
                      {reviewSearchLimit >= 500 ? '已达到结果上限' : '加载更多匹配'}
                    </Button>
                  )}
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
              onClick={() => setReviewPreferences((current) => ({
                ...current,
                viewMode: current.viewMode === 'unified' ? 'split' : 'unified',
              }))}
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
            {state.runId && (
              <Button
                variant="outline"
                size="sm"
                className="ml-1 h-7 gap-1 border-[color:color-mix(in_oklab,var(--lume-danger)_45%,transparent)] bg-transparent px-2.5 text-ui text-[var(--lume-danger)] hover:bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,transparent)] hover:text-[var(--lume-danger)]"
                title={runRevertible ? '按快照还原本次 Run 的文件改动（不可逆）' : 'Coding Run 结束后才能撤销'}
                disabled={revertBusy || !runRevertible}
                onClick={() => void revertRunChanges()}
              >
                <span>{revertBusy ? '还原中…' : '撤销本次改动'}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="ml-1 h-7 gap-1 border-[var(--lume-border-strong)] bg-transparent px-2.5 text-[12px] text-[var(--lume-text-primary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
              title="提交或推送"
              onClick={() => {
                setIncludeUnstagedChanges(false)
                setPublishDialogOpen(true)
                void loadPublishState()
              }}
            >
              <span>提交或推送</span><ChevronDown className="size-3.5" />
            </Button>
            {revertNotice && (
              <span className="ml-2 truncate text-caption text-[var(--lume-text-muted)]" title={revertNotice}>{revertNotice}</span>
            )}
          </div>
        </div>
      </header>
      {actionError && <div className="border-b border-[color:color-mix(in_oklab,var(--lume-danger)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,var(--lume-bg-panel))] px-3 py-1.5 text-[11px] text-[var(--lume-danger)]">{actionError}</div>}
      <div ref={reviewViewportHostRef} className="relative min-h-0 flex-1">
        <Virtualizer
          className="coding-review-scrollbar absolute inset-0 overflow-auto"
          contentClassName="min-w-0"
          config={{ overscrollSize: 500 }}
        >
          {renderedChanges.map((change) => {
            const source = activeSource
            const fileKey = codingReviewFileKey(change)
            const key = diffStateKey(source, state.runId, change)
            const expanded = expandedPaths.has(fileKey)
            const unseen = reviewStatus?.unseenPaths.includes(fileKey) ?? false
            const rowRef = (element: HTMLDivElement | null) => {
              if (element) fileRowRefs.current.set(fileKey, element)
              else fileRowRefs.current.delete(fileKey)
            }
            return (
              <Fragment key={fileKey}>
                {expanded ? (
                  <InlineFileDiff
                    rowRef={rowRef}
                    threadId={threadId}
                    runId={state.runId}
                    change={change}
                    review={reviews[key] ?? null}
                    loading={loadingDiffs.has(key)}
                    error={diffErrors[key] ?? null}
                    viewMode={diffViewMode}
                    wrapLines={wrapDiffLines}
                    omitFullFile={omitFullFile}
                    richPreviewEnabled={richPreviewEnabled}
                    wordDiffsEnabled={wordDiffsEnabled}
                    hideWhitespace={hideWhitespace}
                    reviewSource={isWorkspaceSource ? workspaceReviewSource : undefined}
                    unseen={unseen}
                    onRetry={() => retryDiff(change)}
                    onCollapse={() => toggleDiff(change)}
                    onToggleWrap={() => setReviewPreferences((current) => ({ ...current, wrapLines: !current.wrapLines }))}
                    onOpenFile={onOpenFile}
                    onMarkReviewed={() => reviewStatusAction({ type: 'mark-reviewed', threadId, path: fileKey })}
                    onMarkUnreviewed={() => reviewStatusAction({ type: 'mark-unreviewed', threadId, path: fileKey })}
                    onRevertFile={fileRevertible ? () => void revertFileChange(change) : undefined}
                    revertBusy={fileRevertBusyPath === fileKey}
                    onDiffAction={(action, hunkIndex) => {
                      const review = reviews[key]
                      if (review) void applyDiffAction(change, review, action, hunkIndex)
                    }}
                  />
                ) : <ChangeFileButton rowRef={rowRef} change={change} unseen={unseen} onPrefetch={() => prefetchDiff(change)} onClick={() => toggleDiff(change)} onOpenFile={onOpenFile} onMarkReviewed={() => reviewStatusAction({ type: 'mark-reviewed', threadId, path: fileKey })} onMarkUnreviewed={() => reviewStatusAction({ type: 'mark-unreviewed', threadId, path: fileKey })} />}
              </Fragment>
            )
          })}
          {visibleChanges.length === 0 && (
            <div className="p-8 text-center text-[12px] text-[var(--lume-text-muted)]">
              <div className="font-medium text-[var(--lume-text-secondary)]">
                {activeSource.kind === 'staged'
                  ? '没有已暂存的变更'
                  : activeSource.kind === 'unstaged'
                    ? '没有未暂存的变更'
                    : activeSource.kind === 'branch'
                      ? '与该分支相比没有变更'
                      : activeSource.kind === 'commit'
                        ? '该提交没有文件变更'
                    : '没有文件变更'}
              </div>
              {activeSource.kind === 'staged' && <div className="mt-1">Stage 修改后会显示在这里</div>}
              {activeSource.kind === 'unstaged' && <div className="mt-1">工作区修改会显示在这里</div>}
            </div>
          )}
        </Virtualizer>
        {isCappedMode && visibleChanges.length > 0 && (
          <div className="pointer-events-none absolute inset-x-4 bottom-3 z-20 border-t border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] pt-2 text-center text-[12px] text-[var(--lume-text-muted)]">
            此 Diff 较大，每次仅显示一个文件
          </div>
        )}
        {canApplySectionAction && (
          <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--lume-border-strong)] bg-[color:color-mix(in_oklab,var(--lume-bg-panel)_92%,transparent)] px-2 py-1 shadow-lg backdrop-blur">
            {diffActionPending && <Loader2 className="ml-1 size-3.5 animate-spin text-[var(--lume-text-muted)]" />}
            <Button variant="ghost" size="xs" disabled={diffActionPending} className="rounded-full" onClick={() => void applySectionAction(sectionAction)}>
              {sectionAction === 'stage' ? 'Stage all' : 'Unstage all'}
            </Button>
          </div>
        )}
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
      <Dialog open={publishDialogOpen} onOpenChange={(open) => {
        if (!publishBusy) setPublishDialogOpen(open)
      }}>
        <DialogContent showCloseButton={false} className="w-[420px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 sm:max-w-[420px]">
          <DialogHeader className="px-3 pb-2 pt-3">
            <DialogTitle>提交或推送</DialogTitle>
            <DialogDescription>选择要提交的改动，并决定下一步 Git 操作。</DialogDescription>
          </DialogHeader>
          {!publishState && !publishError && (
            <div className="flex min-h-32 items-center justify-center border-t border-[var(--lume-border-subtle)] text-[12px] text-[var(--lume-text-muted)]">
              <Loader2 className="mr-2 size-4 animate-spin" />正在读取 Git 状态…
            </div>
          )}
          {publishError && (
            <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--lume-danger)_30%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,transparent)] px-3 py-2 text-[12px] text-[var(--lume-danger)]">
              <span className="min-w-0 flex-1">{publishError}</span>
              {!publishBusy && !publishState && <Button variant="ghost" size="xs" onClick={() => void loadPublishState()}>重试</Button>}
            </div>
          )}
          {publishState && !publishState.available && (
            <div className="mx-3 mb-3 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-3 py-3 text-[12px] text-[var(--lume-text-secondary)]">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1">{publishState.reason}</span>
                {!publishBusy && <Button variant="ghost" size="xs" onClick={() => void loadPublishState()}>重试</Button>}
              </div>
            </div>
          )}
          {publishState?.available && (
            <>
              <div className="mx-3 mb-3 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-3 py-2 text-[12px] text-[var(--lume-text-secondary)]">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-[var(--lume-text-primary)]">{publishState.rootLabel} · {publishState.branch}</span>
                  <span className="shrink-0">{publishState.upstream ?? '未设置 upstream'}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--lume-text-muted)]">
                  <span>{publishState.stagedCount} 个已 Stage</span>
                  <span>{publishState.unstagedCount} 个未 Stage</span>
                  <span>{publishState.untrackedCount} 个未跟踪</span>
                  {publishState.upstream && <span>领先 {publishState.ahead} / 落后 {publishState.behind}</span>}
                </div>
              </div>
              {publishState.behind > 0 && (
                <div className="mx-3 mb-2 text-[11px] text-[var(--lume-warning)]">当前分支落后 upstream；Lume 不会自动 pull、rebase 或 force push。</div>
              )}
              <div className="border-t border-[var(--lume-border-subtle)] px-3 py-2">
                <label htmlFor="coding-review-commit-message" className="mb-1.5 block text-[11px] font-medium text-[var(--lume-text-secondary)]">提交消息</label>
                <Textarea
                  id="coding-review-commit-message"
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  disabled={publishBusy || publishState.stagedCount + publishState.unstagedCount + publishState.untrackedCount === 0}
                  maxLength={5_000}
                  placeholder="输入提交消息…"
                  className="min-h-20 resize-y text-[12px]"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void applyPublishAction('commit')
                    }
                  }}
                />
                <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--lume-text-secondary)]">
                  <Checkbox
                    checked={includeUnstagedChanges}
                    disabled={publishBusy || publishState.unstagedCount + publishState.untrackedCount === 0}
                    onCheckedChange={(checked) => setIncludeUnstagedChanges(checked === true)}
                  />
                  <span>包含未暂存和未跟踪的变更</span>
                </label>
              </div>
              <div className="border-t border-[var(--lume-border-subtle)] p-1">
                {([
                  { action: 'commit' as const, label: '提交', Icon: GitCommitHorizontal },
                  { action: 'commit_and_push' as const, label: '提交并推送', Icon: Upload },
                  { action: 'push' as const, label: '推送', Icon: Upload },
                ]).map(({ action, label, Icon }) => {
                  const reason = codingPublishActionDisabledReason(publishState, action, {
                    commitMessage,
                    includeUnstagedChanges,
                    busy: publishBusy,
                  })
                  return (
                    <PublishActionRow
                      key={action}
                      Icon={Icon}
                      label={label}
                      reason={reason}
                      loading={publishPendingAction === action}
                      onClick={() => void applyPublishAction(action)}
                    />
                  )
                })}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function PublishActionRow({ Icon, label, reason, loading, onClick }: {
  Icon: LucideIcon
  label: string
  reason?: string
  loading: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      className="h-auto min-h-10 w-full justify-start gap-2 px-2 py-1.5 text-left"
      disabled={Boolean(reason)}
      title={reason}
      onClick={onClick}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium">{loading ? `${label}中…` : label}</span>
        {reason && <span className="block truncate text-[10px] font-normal text-[var(--lume-text-muted)]">{reason}</span>}
      </span>
    </Button>
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

type ReviewAnnotation =
  | { kind: 'hunk-actions'; hunkIndex: number }
  | { kind: 'comment-editor' }
  | { kind: 'readonly-comment'; comment: AgentDiffCommentAttachment; pending: boolean }

function InlineFileDiff({ rowRef, threadId, runId, change, review, loading, error, viewMode, wrapLines, omitFullFile, richPreviewEnabled, wordDiffsEnabled, hideWhitespace, reviewSource, unseen, onRetry, onCollapse, onToggleWrap, onOpenFile, onMarkReviewed, onMarkUnreviewed, onRevertFile, revertBusy, onDiffAction }: {
  rowRef: (element: HTMLDivElement | null) => void
  threadId: string
  runId?: string
  change: RuntimeCodingFileChange
  review: CodingDiffPayload | null
  loading: boolean
  error: string | null
  viewMode: 'unified' | 'split'
  wrapLines: boolean
  omitFullFile: boolean
  richPreviewEnabled: boolean
  wordDiffsEnabled: boolean
  hideWhitespace: boolean
  reviewSource?: WorkspaceCodingReviewSource
  unseen: boolean
  onRetry: () => void
  onCollapse: () => void
  onToggleWrap: () => void
  onOpenFile?: (path: string) => void
  onMarkReviewed: () => void
  onMarkUnreviewed: () => void
  onRevertFile?: () => void
  revertBusy?: boolean
  onDiffAction: (action: CodingDiffActionInput['action'], hunkIndex?: number) => void
}) {
  const path = change.path
  const [copied, setCopied] = useState(false)
  const [richPreview, setRichPreview] = useState(review?.kind === 'media')
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null)
  const [commentText, setCommentText] = useState('')
  const [commentRange, setCommentRange] = useState<SelectedLineRange | null>(null)
  const [openTargetsState, setOpenTargetsState] = useState<
    | { status: 'idle' | 'loading' }
    | { status: 'ready'; targets: CodingFileOpenTargets }
    | { status: 'error' }
  >({ status: 'idle' })
  const commentDrafts = useAtomValue(agentDiffCommentDraftsFamily(threadId)) ?? []
  const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
  const setCommentDrafts = useSetAtom(agentDiffCommentDraftsAtom)
  const stageFilter: CodingReviewStageFilter | undefined = reviewSource?.kind === 'uncommitted'
    || reviewSource?.kind === 'unstaged'
    || reviewSource?.kind === 'staged'
    ? reviewSource.kind
    : undefined
  const reviewAction = stageFilter === 'staged' ? 'unstage' : stageFilter ? 'stage' : null
  const reviewTooLarge = useMemo(
    () => review?.kind === 'text' && isReviewFileTooLarge(review),
    [review],
  )
  const canToggleRich = Boolean(review?.kind === 'text' && /\.(?:md|markdown|mdown|mdx|mkd|svg)$/i.test(path))
  const relatedComments = useMemo(() => {
    const matches = (comment: AgentDiffCommentAttachment) => (
      comment.position.path.replace(/\\/g, '/') === path.replace(/\\/g, '/')
      && (!comment.position.rootId || comment.position.rootId === change.rootId)
      && (!comment.position.runId || comment.position.runId === runId)
    )
    const sent = runtimeEvents.flatMap((event) => (
      event.type === 'message.user.submitted' ? event.commentAttachments ?? [] : []
    )).filter(matches)
    const uniqueSent = [...new Map(sent.map((comment) => [comment.id, comment])).values()]
    return [
      ...commentDrafts.filter(matches).map((comment) => ({ comment, pending: true })),
      ...uniqueSent.filter((comment) => !commentDrafts.some((draft) => draft.id === comment.id))
        .map((comment) => ({ comment, pending: false })),
    ]
  }, [change.rootId, commentDrafts, path, runId, runtimeEvents])

  useEffect(() => {
    setRichPreview(review?.kind === 'media' || (richPreviewEnabled && canToggleRich))
  }, [canToggleRich, review?.kind, review?.diffHash, richPreviewEnabled])

  useEffect(() => {
    setOpenTargetsState({ status: 'idle' })
  }, [change.rootId, path, runId, threadId])

  const loadOpenTargets = () => {
    if (openTargetsState.status !== 'idle') return
    setOpenTargetsState({ status: 'loading' })
    void sidecarCall<CodingFileOpenTargets>(AGENT_IPC_CHANNELS.GET_CODING_FILE_OPEN_TARGETS, {
      threadId,
      runId,
      rootId: change.rootId,
      path,
    }).then((targets) => {
      setOpenTargetsState({ status: 'ready', targets })
    }).catch(() => {
      setOpenTargetsState({ status: 'error' })
    })
  }

  const openTarget = async (action: () => Promise<unknown>, failureMessage: string) => {
    try {
      await action()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : failureMessage)
    }
  }

  const copyDiff = async () => {
    if (!review) return
    await writeClipboardText(review.kind === 'text' ? review.patch : `${review.path} (${review.kind})`)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const openComment = (range: SelectedLineRange | null) => {
    if (!range) return
    setSelectedLines(range)
    setCommentRange(range)
  }
  const saveComment = () => {
    if (!review || !commentRange || !commentText.trim()) return
    const side = commentRange.endSide ?? commentRange.side ?? 'additions'
    const attachment: AgentDiffCommentAttachment = {
      id: crypto.randomUUID(),
      origin: 'diff',
      position: {
        path,
        rootId: change.rootId,
        runId,
        side: side === 'deletions' ? 'left' : 'right',
        line: commentRange.end,
        startLine: commentRange.start,
        startSide: (commentRange.side ?? side) === 'deletions' ? 'left' : 'right',
      },
      body: commentText.trim(),
      ...(review.kind === 'text' ? { localDiffHunk: selectedPatchHunk(review.patch, commentRange) } : {}),
    }
    setCommentDrafts((current) => ({
      ...current,
      [threadId]: [...(current[threadId] ?? []), attachment],
    }))
    setCommentText('')
    setCommentRange(null)
    setSelectedLines(null)
  }
  const lineAnnotations = useMemo<DiffLineAnnotation<ReviewAnnotation>[]>(() => {
    if (!review || review.kind !== 'text' || reviewTooLarge) return []
    const annotations: DiffLineAnnotation<ReviewAnnotation>[] = []
    try {
      const files = createPierreFileDiff(omitFullFile && !hideWhitespace
        ? { patch: review.patch, filePath: review.path, cacheKey: review.diffHash }
        : {
            oldContent: review.oldContent,
            newContent: review.newContent,
            filePath: review.path,
            cacheKey: `${review.diffHash}:${hideWhitespace ? 'ignore-whitespace' : 'all'}`,
            ignoreWhitespace: hideWhitespace,
          })
      if (
        ((reviewAction === 'stage' && review.actions.canStage) || (reviewAction === 'unstage' && review.actions.canUnstage))
        && !hideWhitespace
        && review.status !== 'untracked'
        && (stageFilter !== 'uncommitted' || !(review.actions.staged && review.actions.unstaged))
      ) {
        files[0]?.hunks.forEach((hunk, hunkIndex) => {
          const side = hunk.additionCount > 0 ? 'additions' : 'deletions'
          annotations.push({
            side,
            lineNumber: Math.max(1, side === 'additions'
              ? hunk.additionStart + hunk.additionCount - 1
              : hunk.deletionStart + hunk.deletionCount - 1),
            metadata: { kind: 'hunk-actions', hunkIndex },
          })
        })
      }
    } catch {
      // Pierre 本体会渲染解析错误；这里不重复制造 annotation。
    }
    if (commentRange) {
      annotations.push({
        side: commentRange.endSide ?? commentRange.side ?? 'additions',
        lineNumber: commentRange.end,
        metadata: { kind: 'comment-editor' },
      })
    }
    for (const { comment, pending } of relatedComments) {
      annotations.push({
        side: comment.position.side === 'left' ? 'deletions' : 'additions',
        lineNumber: comment.position.line,
        metadata: { kind: 'readonly-comment', comment, pending },
      })
    }
    return annotations
  }, [commentRange, hideWhitespace, omitFullFile, relatedComments, review, reviewAction, reviewTooLarge, stageFilter])
  const addedLines = review?.addedLines ?? change.addedLines ?? 0
  const removedLines = review?.removedLines ?? change.removedLines ?? 0
  const renderAnnotation = (annotation: DiffLineAnnotation<ReviewAnnotation>) => {
    if (annotation.metadata.kind === 'comment-editor') {
      return (
        <div className="mx-2 my-1.5 rounded-xl border border-[var(--lume-border-strong)] bg-[var(--lume-bg-panel)] p-2.5 shadow-[0_10px_30px_-22px_hsl(var(--lume-shadow-panel)/0.7)]">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--lume-text-secondary)]">
            <MessageSquareText className="size-3.5 text-[var(--lume-accent)]" />
            添加评论
          </div>
          <Textarea
            value={commentText}
            onChange={(event) => setCommentText(event.target.value)}
            placeholder="留下审阅意见…"
            className="min-h-20 resize-y border-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)] text-xs shadow-none"
            autoFocus
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <Button variant="ghost" size="xs" onClick={() => { setCommentRange(null); setSelectedLines(null); setCommentText('') }}>取消</Button>
            <Button size="xs" disabled={!commentText.trim()} onClick={saveComment}>添加意见</Button>
          </div>
        </div>
      )
    }
    if (annotation.metadata.kind === 'readonly-comment') {
      return (
        <div className="mx-2 my-1.5 rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] px-3 py-2.5 text-xs text-[var(--lume-text-secondary)] shadow-sm">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--lume-text-muted)]">
            {annotation.metadata.pending ? '待发送的审阅意见' : '已发送的审阅意见'}
          </div>
          <p className="m-0 whitespace-pre-wrap">{annotation.metadata.comment.body}</p>
        </div>
      )
    }
    const hunkIndex = annotation.metadata.hunkIndex
    return (
      <div className="mx-2 my-1 flex min-h-8 items-center justify-end gap-1.5 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] px-2 py-1">
        <span className="mr-auto text-[10px] text-[var(--lume-text-muted)]">Hunk {hunkIndex + 1}</span>
        {reviewAction === 'stage' && review?.actions.canStage && <Button variant="ghost" size="xs" className="h-6 px-2 text-[11px]" onClick={() => onDiffAction('stage', hunkIndex)}>Stage</Button>}
        {reviewAction === 'unstage' && review?.actions.canUnstage && <Button variant="ghost" size="xs" className="h-6 px-2 text-[11px]" onClick={() => onDiffAction('unstage', hunkIndex)}>Unstage</Button>}
      </div>
    )
  }
  const requestChanges = () => {
    if (!review || review.kind !== 'text' || reviewTooLarge) return
    try {
      const file = createPierreFileDiff({
        oldContent: review.oldContent,
        newContent: review.newContent,
        filePath: review.path,
        cacheKey: review.diffHash,
      })[0]
      const hunk = file?.hunks[0]
      if (!hunk) throw new Error('文件没有可评论的变更行')
      const side = hunk.additionCount > 0 ? 'additions' : 'deletions'
      const line = side === 'additions' ? hunk.additionStart : hunk.deletionStart
      openComment({ start: Math.max(1, line), end: Math.max(1, line), side })
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法定位变更行')
    }
  }
  const copySelection = async () => {
    const selection = window.getSelection()?.toString().trim() ?? ''
    if (!selection) {
      toast.error('请先选择 Diff 文本')
      return
    }
    await writeClipboardText(selection)
    toast.success('已复制所选文本')
  }
  const copyPath = async () => {
    await writeClipboardText(path)
    toast.success('已复制文件路径')
  }

  const card = (
    <div
      ref={rowRef}
      className="scroll-mt-1 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)]"
    >
      <div className="group sticky top-0 z-10 flex h-8 items-center border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] text-[12px] transition-colors hover:bg-[color:color-mix(in_oklab,var(--lume-text-primary)_5%,transparent)]">
        <Button variant="ghost" size="sm" className="h-full min-w-0 flex-1 justify-start gap-2 rounded-none px-3 text-left font-normal hover:bg-transparent" onClick={onCollapse} title="收起 Diff">
          <FileTypeIcon filename={path} size={14} />
          <FileChangeLabel path={path} addedLines={addedLines} removedLines={removedLines} emphasized />
          <ChevronDown className="size-3.5 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
        </Button>
        {onOpenFile && change.status !== 'deleted' && <Button variant="ghost" size="icon-sm" className="pointer-events-none size-6 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-text-primary)]" onClick={() => onOpenFile(path)} title="在标签中打开" aria-label={`在标签中打开 ${path}`}><ExternalLink className="size-3.5" /></Button>}
        {canToggleRich && <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setRichPreview((value) => !value)}>{richPreview ? '代码' : '预览'}</Button>}
        {reviewAction === 'stage' && review?.actions.canStage && <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => onDiffAction('stage')}>Stage</Button>}
        {reviewAction === 'unstage' && review?.actions.canUnstage && <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => onDiffAction('unstage')}>Unstage</Button>}
        {review && <Button variant="ghost" size="icon-sm" className="pointer-events-none size-6 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-text-primary)]" onClick={() => void copyDiff()} title="复制 Diff" aria-label="复制 Diff">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button>}
        {onRevertFile && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={revertBusy}
            className="pointer-events-none size-6 shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-transparent hover:text-[var(--lume-danger)]"
            onClick={onRevertFile}
            title="撤销此文件的改动（按 Run 前快照还原）"
            aria-label={`撤销 ${path} 的改动`}
          >
            {revertBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={!unseen}
          className={cn(
            'ml-auto mr-2 h-7 shrink-0 gap-1 px-2 text-[12px] text-[var(--lume-text-secondary)] hover:bg-transparent hover:text-[var(--lume-text-primary)]',
            unseen && 'pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100',
          )}
          onClick={unseen ? onMarkReviewed : onMarkUnreviewed}
        >
          {!unseen && <Check className="size-3.5" />}
          {unseen ? '标记为已查看' : '已查看'}
        </Button>
      </div>
      {loading ? (
        <div className="flex min-h-20 items-center justify-center text-[12px] text-[var(--lume-text-muted)]"><Loader2 className="mr-2 size-3.5 animate-spin" />正在加载文件内容…</div>
      ) : error ? (
        <div className="flex min-h-16 items-start gap-2 px-3 py-2 text-[12px] text-[var(--lume-text-secondary)]"><span className="min-w-0 flex-1 break-words"><span className="font-medium text-[var(--lume-text-primary)]">完整文件内容加载失败：</span>{error}</span><Button variant="outline" size="sm" className="h-6 shrink-0 border-[var(--lume-border-strong)] bg-transparent px-2 text-[11px] text-[var(--lume-text-primary)] hover:bg-[var(--lume-bg-elevated)]" onClick={onRetry}>重试</Button></div>
      ) : reviewTooLarge ? (
        <div className="flex min-h-12 items-center gap-2 bg-[var(--lume-bg-app)] px-3 py-2 text-[12px] text-[var(--lume-text-secondary)]">
          <span className="min-w-0 flex-1">此文件过大，无法在审阅面板中显示。</span>
          {onOpenFile && change.status !== 'deleted' && (
            <Button variant="ghost" size="xs" onClick={() => onOpenFile(path)}>在编辑器中打开</Button>
          )}
        </div>
      ) : review && (richPreview || review.kind !== 'text') ? (
        <CodingRichDiffPreview
          threadId={threadId}
          runId={reviewSource ? undefined : runId}
          reviewSource={reviewSource}
          review={review}
        />
      ) : review?.kind === 'text' ? (
        <PierreDiffView<ReviewAnnotation>
          patch={omitFullFile && !hideWhitespace ? review.patch : undefined}
          oldContent={omitFullFile && !hideWhitespace ? undefined : review.oldContent}
          newContent={omitFullFile && !hideWhitespace ? undefined : review.newContent}
          filePath={review.path}
          cacheKey={review.diffHash}
          viewMode={viewMode}
          wrapLines={wrapLines}
          ignoreWhitespace={hideWhitespace}
          lineDiffType={wordDiffsEnabled ? 'word' : 'none'}
          {...REVIEW_DIFF_CONTEXT_OPTIONS}
          compact={omitFullFile}
          virtualizer="parent"
          disableHeader
          selectedLines={selectedLines}
          lineAnnotations={lineAnnotations}
          enableLineSelection
          enableGutterUtility
          onLineSelected={openComment}
          onLineSelectionChange={setSelectedLines}
          onGutterUtilityClick={openComment}
          renderAnnotation={renderAnnotation}
        />
      ) : null}
    </div>
  )

  return (
    <ContextMenu onOpenChange={(open) => {
      if (open) loadOpenTargets()
    }}>
      <ContextMenuTrigger render={card} />
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem disabled={!review || review.kind !== 'text' || reviewTooLarge} onSelect={requestChanges}>
          <MessageSquareText className="size-3.5" />请求更改
        </ContextMenuItem>
        {onOpenFile && change.status !== 'deleted' && (
          <ContextMenuItem onSelect={() => onOpenFile(path)}>
            <ExternalLink className="size-3.5" />在标签中打开
          </ContextMenuItem>
        )}
        {openTargetsState.status === 'loading' && (
          <ContextMenuItem disabled>
            <Loader2 className="size-3.5 animate-spin" />正在检查打开方式…
          </ContextMenuItem>
        )}
        {openTargetsState.status === 'error' && (
          <ContextMenuItem disabled>
            <ExternalLink className="size-3.5" />无法获取外部打开方式
          </ContextMenuItem>
        )}
        {openTargetsState.status === 'ready' && openTargetsState.targets.remoteFileUrl && (
          <ContextMenuItem onSelect={() => void openTarget(
            () => openExternal(openTargetsState.targets.remoteFileUrl!),
            '无法打开远程文件',
          )}>
            <ExternalLink className="size-3.5" />
            在 {openTargetsState.targets.remoteProvider === 'gitlab' ? 'GitLab' : 'GitHub'} 查看 HEAD 版本
          </ContextMenuItem>
        )}
        {openTargetsState.status === 'ready' && openTargetsState.targets.absolutePath && (
          <>
            <ContextMenuItem onSelect={() => void openTarget(
              () => openInSystem(openTargetsState.targets.absolutePath!),
              '无法使用系统默认程序打开文件',
            )}>
              <FileText className="size-3.5" />使用系统默认程序打开
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void openTarget(
              () => revealPathInSystem(openTargetsState.targets.absolutePath!),
              '无法在资源管理器中显示文件',
            )}>
              <FolderOpen className="size-3.5" />在资源管理器中显示
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copySelection()}>
          <Copy className="size-3.5" />复制所选文本
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyPath()}>
          <FileText className="size-3.5" />复制路径
        </ContextMenuItem>
        <ContextMenuItem onSelect={onToggleWrap}>
          <WrapText className="size-3.5" />切换自动换行
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function selectedPatchHunk(patch: string, range: SelectedLineRange): string {
  const lines = patch.replace(/\r\n?/g, '\n').split('\n')
  const side = range.endSide ?? range.side ?? 'additions'
  let oldLine = 0
  let newLine = 0
  const selected: string[] = []
  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      selected.push(line)
      continue
    }
    const lineNumber = side === 'deletions' ? oldLine : newLine
    if (lineNumber >= range.start && lineNumber <= range.end) selected.push(line)
    if (line.startsWith(' ') || line.startsWith('-')) oldLine += 1
    if (line.startsWith(' ') || line.startsWith('+')) newLine += 1
  }
  return selected.join('\n').slice(0, 100_000)
}

function ChangeFileButton({ rowRef, change, unseen, onPrefetch, onClick, onOpenFile, onMarkReviewed, onMarkUnreviewed }: {
  rowRef: (element: HTMLDivElement | null) => void
  change: RuntimeCodingFileChange
  unseen: boolean
  onPrefetch: () => void
  onClick: () => void
  onOpenFile?: (path: string) => void
  onMarkReviewed: () => void
  onMarkUnreviewed: () => void
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
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={!unseen}
        className={cn(
          'ml-auto mr-2 h-7 shrink-0 gap-1 px-2 text-[12px] text-[var(--lume-text-secondary)] hover:bg-transparent hover:text-[var(--lume-text-primary)]',
          unseen && 'pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100',
        )}
        onClick={unseen ? onMarkReviewed : onMarkUnreviewed}
      >
        {!unseen && <Check className="size-3.5" />}
        {unseen ? '标记为已查看' : '已查看'}
      </Button>
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

function DiffSearchMatchLabel({ match }: { match: CodingReviewSearchMatch }) {
  const before = match.preview.slice(0, match.matchStart)
  const value = match.preview.slice(match.matchStart, match.matchStart + match.matchLength)
  const after = match.preview.slice(match.matchStart + match.matchLength)
  const lineLabel = match.kind === 'line'
    ? `${match.side === 'deletions' ? '−' : match.side === 'additions' ? '+' : '·'}${match.lineNumber ?? ''}`
    : null
  return (
    <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <span className="flex min-w-0 items-center gap-2">
        <FileTypeIcon filename={match.path} size={13} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--lume-text-muted)]">{match.path}</span>
        {lineLabel && <span className="shrink-0 font-mono text-[10px] text-[var(--lume-text-muted)]">{lineLabel}</span>}
      </span>
      <span className="mt-0.5 min-w-0 truncate font-mono text-[11px] text-[var(--lume-text-secondary)]">
        {before}
        <mark className="rounded-sm bg-[color:color-mix(in_oklab,var(--lume-accent)_24%,transparent)] px-0 text-[var(--lume-text-primary)]">{value}</mark>
        {after}
      </span>
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
    <span className="flex min-w-0 items-center overflow-hidden text-[12px] leading-4">
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
