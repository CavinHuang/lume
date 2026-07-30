import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  activeTabIdAtom,
  agentRuntimeEventsFamily,
  agentThreadsAtom,
  agentWorkspacesAtom,
  codingReviewPanelActionAtom,
  codingReviewPanelsAtom,
  currentWorkspaceIdAtom,
  rightPanelFileWorkspacesAtom,
  rightPanelLayoutAtom,
  rightPanelWorkspaceActionAtom,
  rightPanelWorkspacesAtom,
  tabsAtom,
} from '@/atoms'
import { PanelRightOpen } from 'lucide-react'
import { revokeFilePreviewScope } from '@/lib/desktop-api'
import { onSidecarEvent } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, MEMORY_IPC_CHANNELS, type FileSource } from '@lume/shared'
import { cn } from '@/lib/utils'
import {
  createThreadFileWorkspace,
  getEffectiveThreadFileBindings,
  reconcileThreadFileWorkspaces,
  type ThreadFileWorkspace,
} from './right-panel-files-state'
import {
  createEmptyRightPanelWorkspace,
  firstOpenRightPanelTab,
  getOpenRightPanelFunctions,
  getRightPanelReviewLaunchTarget,
  sanitizeRightPanelWorkspace,
  type RightPanelFunction,
  type ThreadRightPanelWorkspace,
} from './right-panel-state'
import { RIGHT_PANEL_DEFAULT_WIDTH, getRightPanelDragWidth } from './right-panel-layout'
import { RightPanelLauncher } from './RightPanelLauncher'
import { RightPanelTabBar } from './RightPanelTabBar'
import { PlaceholderRightPanelTab } from './PlaceholderRightPanelTab'
import { FilesRightPanelWorkspace } from './FilesRightPanelWorkspace'
import { BrowserRightPanelTab } from './BrowserRightPanelTab'
import { CodingReviewPanel } from './CodingReviewPanel'
import type { CodingReviewPanelState } from '@/atoms/right-panel-atoms'

const PLACEHOLDER_LABELS: Record<RightPanelFunction, string> = {
  browser: '浏览器', files: '文件',
}

type ThreadFileWorkspaceUpdate = ThreadFileWorkspace | ((current: ThreadFileWorkspace) => ThreadFileWorkspace)

export function RightPanelWorkspace({ maxWidth }: { maxWidth: number }) {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const [persisted, setPersisted] = useAtom(rightPanelWorkspacesAtom)
  const [runtime, setRuntime] = useAtom(rightPanelFileWorkspacesAtom)
  const dispatch = useSetAtom(rightPanelWorkspaceActionAtom)
  const [layout, setLayout] = useAtom(rightPanelLayoutAtom)
  const [resizing, setResizing] = useState(false)
  const threads = useAtomValue(agentThreadsAtom)
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const threadId = activeTab?.type === 'agent' ? activeTab.threadId : undefined
  const thread = threads.find((item) => item.id === threadId)
  const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId ?? ''))?.events ?? []
  const reviewLaunchTarget = useMemo(
    () => getRightPanelReviewLaunchTarget(runtimeEvents),
    [runtimeEvents],
  )
  const codingReview = useAtomValue(codingReviewPanelsAtom)[threadId ?? '']
  const closeCodingReview = useSetAtom(codingReviewPanelActionAtom)
  const workspaceId = thread?.workspaceId ?? currentWorkspaceId ?? undefined
  const agentWorkspace = agentWorkspaces.find((item) => item.id === workspaceId)
  const workspaceSlug = agentWorkspace?.slug
  const binding = useMemo(() => ({
    workspaceId,
    fileContextId: thread?.fileContextId ?? thread?.id,
    projectBindingKey: agentWorkspace?.realpathKey ?? agentWorkspace?.projectPath,
  }), [agentWorkspace?.projectPath, agentWorkspace?.realpathKey, workspaceId, thread?.fileContextId, thread?.id])

  useEffect(() => {
    const result = reconcileThreadFileWorkspaces(runtime, getEffectiveThreadFileBindings(threads, currentWorkspaceId).map((item) => ({
      ...item,
      projectBindingKey: (() => {
        const workspace = agentWorkspaces.find((candidate) => candidate.id === item.workspaceId)
        return workspace?.realpathKey ?? workspace?.projectPath
      })(),
      openFunctions: getOpenRightPanelFunctions(sanitizeRightPanelWorkspace(persisted[item.id] ?? createEmptyRightPanelWorkspace()).tabs),
    })))
    if (result.revokedScopeTokens.length > 0
      || Object.keys(result.workspaces).length !== Object.keys(runtime).length
      || Object.entries(result.workspaces).some(([id, value]) => value !== runtime[id])) {
      setRuntime(result.workspaces)
      result.revokedScopeTokens.forEach((token) => void revokeFilePreviewScope(token).catch(() => undefined))
    }
  }, [agentWorkspaces, currentWorkspaceId, persisted, threads])

  useEffect(() => {
    const unlisten = onSidecarEvent((method) => {
      const sources: FileSource[] = method === MEMORY_IPC_CHANNELS.SOURCE_FILES_CHANGED
        ? ['memory']
        : method === AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED
          ? ['session', 'legacy']
          : []
      if (sources.length === 0) return
      setRuntime((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, {
        ...value,
        sourceStatus: sources.reduce((status, source) => ({ ...status, [source]: 'stale' as const }), value.sourceStatus),
      }])))
    })
    return () => { void unlisten.then((dispose) => dispose()) }
  }, [setRuntime])

  const updateRuntime = useCallback((update: ThreadFileWorkspaceUpdate) => {
    if (!threadId) return
    setRuntime((current) => {
      const previous = current[threadId] ?? createThreadFileWorkspace(binding)
      const next = typeof update === 'function' ? update(previous) : update
      return next === previous ? current : { ...current, [threadId]: next }
    })
  }, [binding, setRuntime, threadId])

  if (!threadId || !layout.open) return null

  const persistedWorkspace = sanitizeRightPanelWorkspace(persisted[threadId] ?? createEmptyRightPanelWorkspace())
  const openFunctions = getOpenRightPanelFunctions(persistedWorkspace.tabs)
  const storedRuntimeWorkspace = runtime[threadId]
  const runtimeWorkspace = storedRuntimeWorkspace
    ? reconcileThreadFileWorkspaces({ [threadId]: storedRuntimeWorkspace }, [{ id: threadId, ...binding, openFunctions }]).workspaces[threadId]!
    : createThreadFileWorkspace(
        binding,
        firstOpenRightPanelTab(persistedWorkspace.tabs)
          ? { kind: 'function', type: firstOpenRightPanelTab(persistedWorkspace.tabs)! }
          : null,
      )
  const hasOpenTabs = firstOpenRightPanelTab(persistedWorkspace.tabs) !== null || runtimeWorkspace.openTabs.length > 0 || Boolean(codingReview)

  const updatePersisted = (next: ThreadRightPanelWorkspace) => setPersisted((current) => ({ ...current, [threadId]: next }))
  const action = (value: Parameters<typeof dispatch>[0]) => dispatch(value)

  const compact = layout.mode === 'compact'
  const resolvedMaxWidth = Math.max(360, Math.round(maxWidth))
  const width = compact ? 72 : layout.mode === 'expanded'
    ? resolvedMaxWidth
    : Math.min(layout.width ?? RIGHT_PANEL_DEFAULT_WIDTH, resolvedMaxWidth)

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || compact) return
    event.preventDefault()
    const move = (next: PointerEvent) => setLayout((current) => ({
      ...current, open: true, mode: 'normal',
      width: getRightPanelDragWidth({ clientX: next.clientX, viewportWidth: window.innerWidth, maxWidth: resolvedMaxWidth }),
    }))
    const stop = () => {
      setResizing(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    setResizing(true)
    move(event.nativeEvent)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <aside className={cn('relative z-[60] flex h-full shrink-0 flex-col border-l border-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)] transition-[width] duration-200', resizing && 'transition-none')} style={{ width }}>
      {!compact && <div role="separator" aria-orientation="vertical" aria-label="调整右侧面板宽度" onPointerDown={startResize} className="absolute left-0 top-0 z-20 h-full w-2 -translate-x-1 cursor-col-resize touch-none" />}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--lume-bg-panel)]">
        {compact ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-[var(--lume-text-muted)]"><PanelRightOpen size={18} /></div>
        ) : (
          <>
            <RightPanelTabBar
              workspace={persistedWorkspace}
              fileTabs={runtimeWorkspace.openTabs}
              activeItem={runtimeWorkspace.activeItem}
              reviewOpen={Boolean(codingReview)}
              reviewActive={codingReview?.active}
              onActivateReview={() => closeCodingReview({ type: 'activate', threadId })}
              onCloseReview={() => closeCodingReview({ type: 'close', threadId })}
              onActivateFunction={(fn) => {
                closeCodingReview({ type: 'deactivate', threadId })
                action({ type: 'activate-function', threadId, function: fn, binding })
              }}
              onActivateFile={(tabId) => {
                closeCodingReview({ type: 'deactivate', threadId })
                updateRuntime((current) => ({ ...current, activeItem: { kind: 'file', tabId } }))
              }}
              onCloseFunction={(fn) => action({ type: 'close-function', threadId, function: fn })}
              onCloseFile={(tabId) => action({ type: 'close-file', threadId, tabId })}
              onOpenFunction={(fn) => {
                closeCodingReview({ type: 'deactivate', threadId })
                action({ type: 'activate-function', threadId, function: fn, binding })
              }}
            />
            {hasOpenTabs ? (
              <RightPanelActiveContent
                persisted={persistedWorkspace}
                runtime={runtimeWorkspace}
                workspaceSlug={workspaceSlug}
                workspaceProjectPath={agentWorkspace?.projectPath}
                fileContextId={binding.fileContextId}
                openFunctions={openFunctions}
                onRuntimeChange={updateRuntime}
                onPersistedChange={updatePersisted}
                threadId={threadId}
                codingReview={codingReview}
                onOpenCodingFile={workspaceSlug ? (path) => {
                  closeCodingReview({ type: 'deactivate', threadId })
                  action({
                    type: 'open-file',
                    threadId,
                    ref: { source: 'project', scopeId: workspaceSlug, relativePath: path.replace(/\\/g, '/') },
                    binding,
                  })
                } : undefined}
              />
            ) : (
              <RightPanelLauncher
                review={reviewLaunchTarget ? {
                  recency: reviewLaunchTarget.recency,
                  fileCount: reviewLaunchTarget.changes.length,
                } : undefined}
                onOpenReview={reviewLaunchTarget ? () => {
                  const { report, changes } = reviewLaunchTarget
                  closeCodingReview({
                    type: 'open',
                    threadId,
                    changes,
                    selectedPath: '',
                    runId: report.runId,
                    turnId: report.turnId,
                    assistantMessageId: report.assistantMessageId,
                    phase: report.phase,
                    verificationRecords: report.verificationRecords,
                    recommendedVerificationCommands: report.recommendedVerificationCommands,
                    gitActions: report.gitActions,
                    review: report.review,
                  })
                } : undefined}
                onOpen={(fn) => action({ type: 'activate-function', threadId, function: fn, binding })}
              />
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function RightPanelActiveContent({ persisted, runtime, workspaceSlug, workspaceProjectPath, fileContextId, openFunctions, onRuntimeChange, onPersistedChange, threadId, codingReview, onOpenCodingFile }: {
  persisted: ThreadRightPanelWorkspace
  runtime: ThreadFileWorkspace
  workspaceSlug?: string
  workspaceProjectPath?: string
  fileContextId?: string
  openFunctions: RightPanelFunction[]
  onRuntimeChange: (workspace: ThreadFileWorkspaceUpdate) => void
  onPersistedChange: (workspace: ThreadRightPanelWorkspace) => void
  threadId: string
  codingReview?: CodingReviewPanelState
  onOpenCodingFile?: (path: string) => void
}) {
  if (codingReview?.active) {
    return <CodingReviewPanel threadId={threadId} state={codingReview} onOpenFile={onOpenCodingFile} />
  }
  const active = runtime.activeItem
  if (!active) return <PlaceholderRightPanelTab label="" />
  if (active.kind === 'file' || active.type === 'files') {
    return <FilesRightPanelWorkspace threadId={threadId} workspace={runtime} workspaceSlug={workspaceSlug} workspaceProjectPath={workspaceProjectPath} fileContextId={fileContextId} openFunctions={openFunctions} onWorkspaceChange={onRuntimeChange} />
  }
  const tabState = persisted.tabs[active.type]
  if (tabState?.type === 'browser') {
    return <BrowserRightPanelTab state={tabState} onChange={(next) => onPersistedChange({ tabs: { ...persisted.tabs, browser: next } })} />
  }
  return <PlaceholderRightPanelTab label={PLACEHOLDER_LABELS[active.type]} />
}
