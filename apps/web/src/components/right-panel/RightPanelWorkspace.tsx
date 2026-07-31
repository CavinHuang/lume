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
  rightPanelFileTabsAtom,
  rightPanelBrowserWorkspacesAtom,
  rightPanelLayoutAtom,
  rightPanelWorkspaceActionAtom,
  rightPanelWorkspacesAtom,
  tabsAtom,
} from '@/atoms'
import { PanelRightOpen } from 'lucide-react'
import { browserRuntime, revokeFilePreviewScope } from '@/lib/desktop-api'
import { onSidecarEvent } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, MEMORY_IPC_CHANNELS, type BrowserTabDescriptor, type FileSource } from '@lume/shared'
import { cn } from '@/lib/utils'
import {
  createThreadFileWorkspace,
  getEffectiveThreadFileBindings,
  normalizePersistedRightPanelFileTabs,
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
} from './right-panel-state'
import { RIGHT_PANEL_DEFAULT_WIDTH, getRightPanelDragWidth } from './right-panel-layout'
import { RightPanelLauncher } from './RightPanelLauncher'
import { RightPanelTabBar } from './RightPanelTabBar'
import { PlaceholderRightPanelTab } from './PlaceholderRightPanelTab'
import { FilesRightPanelWorkspace } from './FilesRightPanelWorkspace'
import { BrowserRightPanelTab } from './BrowserRightPanelTab'
import {
  activateBrowserTab,
  browserTabFromDescriptor,
  closeBrowserTab,
  createBrowserTab,
  duplicateBrowserTab,
  restoreClosedBrowserTab,
  sanitizeThreadBrowserWorkspace,
  type ThreadBrowserWorkspace,
} from './right-panel-browser-state'
import { CodingReviewPanel } from './CodingReviewPanel'
import type { CodingReviewPanelState } from '@/atoms/right-panel-atoms'

const PLACEHOLDER_LABELS: Record<RightPanelFunction, string> = {
  browser: '浏览器', files: '文件',
}

type ThreadFileWorkspaceUpdate = ThreadFileWorkspace | ((current: ThreadFileWorkspace) => ThreadFileWorkspace)

export function RightPanelWorkspace({ maxWidth }: { maxWidth: number }) {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const persisted = useAtomValue(rightPanelWorkspacesAtom)
  const setPersisted = useSetAtom(rightPanelWorkspacesAtom)
  const [runtime, setRuntime] = useAtom(rightPanelFileWorkspacesAtom)
  const [persistedFileTabs, setPersistedFileTabs] = useAtom(rightPanelFileTabsAtom)
  const [persistedBrowserWorkspaces, setPersistedBrowserWorkspaces] = useAtom(rightPanelBrowserWorkspacesAtom)
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
    setPersistedFileTabs((current) => {
      let changed = false
      const next = { ...current }
      for (const [id, workspace] of Object.entries(runtime)) {
        const serialized = {
          tabs: workspace.openTabs.map((tab) => ({ ...tab })),
          ...(workspace.activeItem?.kind === 'file' ? { activeTabId: workspace.activeItem.tabId } : {}),
        }
        if (JSON.stringify(current[id]) === JSON.stringify(serialized)) continue
        next[id] = serialized
        changed = true
      }
      return changed ? next : current
    })
  }, [runtime, setPersistedFileTabs])

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
      const restoredState = persistedFileTabs[threadId]
      const restoredTabs = normalizePersistedRightPanelFileTabs(
        Array.isArray(restoredState) ? restoredState : restoredState?.tabs,
      )
      const restoredActiveId = !Array.isArray(restoredState) ? restoredState?.activeTabId : undefined
      const previous = current[threadId] ?? {
        ...createThreadFileWorkspace(
          binding,
          restoredTabs.find((tab) => tab.id === restoredActiveId)
            ? { kind: 'file', tabId: restoredActiveId! }
            : restoredTabs.at(-1) ? { kind: 'file', tabId: restoredTabs.at(-1)!.id } : null,
        ),
        openTabs: restoredTabs,
      }
      const next = typeof update === 'function' ? update(previous) : update
      return next === previous ? current : { ...current, [threadId]: next }
    })
  }, [binding, persistedFileTabs, setRuntime, threadId])

  useEffect(() => {
    if (!threadId) return
    const onPopupOpened = (event: Event) => {
      const detail = (event as CustomEvent<{ ownerThreadId?: string; popup?: BrowserTabDescriptor }>).detail
      if (!detail?.popup || detail.ownerThreadId !== threadId) return
      const tab = browserTabFromDescriptor(detail.popup)
      setPersistedBrowserWorkspaces((current) => {
        const workspace = sanitizeThreadBrowserWorkspace(current[threadId])
        return {
          ...current,
          [threadId]: {
            ...workspace,
            tabs: [...workspace.tabs.filter((item) => item.id !== tab.id), tab],
            activeTabId: tab.id,
          },
        }
      })
      updateRuntime((current) => ({ ...current, activeItem: { kind: 'browser', tabId: tab.id } }))
    }
    window.addEventListener('lume:browser-popup-opened', onPopupOpened)
    return () => window.removeEventListener('lume:browser-popup-opened', onPopupOpened)
  }, [setPersistedBrowserWorkspaces, threadId, updateRuntime])

  useEffect(() => {
    if (!threadId) return
    const legacy = sanitizeRightPanelWorkspace(persisted[threadId] ?? createEmptyRightPanelWorkspace()).tabs.browser
    const currentBrowser = sanitizeThreadBrowserWorkspace(persistedBrowserWorkspaces[threadId])
    if (!legacy || legacy.type !== 'browser' || currentBrowser.tabs.length > 0) return
    const tab = createBrowserTab({ url: legacy.url, zoomFactor: legacy.zoom })
    setPersistedBrowserWorkspaces((current) => ({
      ...current,
      [threadId]: { tabs: [tab], activeTabId: tab.id, recentlyClosed: [] },
    }))
    setPersisted((current) => {
      const workspace = sanitizeRightPanelWorkspace(current[threadId] ?? createEmptyRightPanelWorkspace())
      const tabs = { ...workspace.tabs }
      delete tabs.browser
      return { ...current, [threadId]: { tabs } }
    })
    updateRuntime((current) => ({ ...current, activeItem: { kind: 'browser', tabId: tab.id } }))
  }, [persisted, persistedBrowserWorkspaces, setPersisted, setPersistedBrowserWorkspaces, threadId, updateRuntime])

  if (!threadId || !layout.open) return null

  const persistedWorkspace = sanitizeRightPanelWorkspace(persisted[threadId] ?? createEmptyRightPanelWorkspace())
  const browserWorkspace = sanitizeThreadBrowserWorkspace(persistedBrowserWorkspaces[threadId])
  const openFunctions = getOpenRightPanelFunctions(persistedWorkspace.tabs)
  const storedRuntimeWorkspace = runtime[threadId]
  const runtimeWorkspace = storedRuntimeWorkspace
    ? reconcileThreadFileWorkspaces({ [threadId]: storedRuntimeWorkspace }, [{ id: threadId, ...binding, openFunctions }]).workspaces[threadId]!
    : (() => {
        const restoredState = persistedFileTabs[threadId]
        const restoredTabs = normalizePersistedRightPanelFileTabs(
          Array.isArray(restoredState) ? restoredState : restoredState?.tabs,
        )
        const restoredActiveId = !Array.isArray(restoredState) ? restoredState?.activeTabId : undefined
        const restored = createThreadFileWorkspace(
          binding,
          browserWorkspace.activeTabId
            ? { kind: 'browser', tabId: browserWorkspace.activeTabId }
          : restoredTabs.find((tab) => tab.id === restoredActiveId)
            ? { kind: 'file', tabId: restoredActiveId! }
            : restoredTabs.at(-1)
              ? { kind: 'file', tabId: restoredTabs.at(-1)!.id }
            : firstOpenRightPanelTab(persistedWorkspace.tabs)
              ? { kind: 'function', type: firstOpenRightPanelTab(persistedWorkspace.tabs)! }
              : null,
        )
        return { ...restored, openTabs: restoredTabs }
      })()
  const hasOpenTabs = firstOpenRightPanelTab(persistedWorkspace.tabs) !== null
    || runtimeWorkspace.openTabs.length > 0
    || browserWorkspace.tabs.length > 0
    || Boolean(codingReview)

  const action = (value: Parameters<typeof dispatch>[0]) => dispatch(value)
  const updateBrowserWorkspace = (next: ThreadBrowserWorkspace) => {
    setPersistedBrowserWorkspaces((current) => ({ ...current, [threadId]: next }))
  }
  const openBrowser = (url = '') => {
    const tab = createBrowserTab({ url })
    updateBrowserWorkspace({ ...browserWorkspace, tabs: [...browserWorkspace.tabs, tab], activeTabId: tab.id })
    closeCodingReview({ type: 'deactivate', threadId })
    updateRuntime((current) => ({ ...current, activeItem: { kind: 'browser', tabId: tab.id } }))
  }
  const activateBrowser = (tabId: string) => {
    updateBrowserWorkspace(activateBrowserTab(browserWorkspace, tabId))
    closeCodingReview({ type: 'deactivate', threadId })
    updateRuntime((current) => ({ ...current, activeItem: { kind: 'browser', tabId } }))
  }
  const closeBrowser = (tabId: string) => {
    const next = closeBrowserTab(browserWorkspace, tabId)
    updateBrowserWorkspace(next)
    void browserRuntime({ method: 'close', params: { tabId } }).catch(() => undefined)
    if (runtimeWorkspace.activeItem?.kind !== 'browser' || runtimeWorkspace.activeItem.tabId !== tabId) return
    updateRuntime((current) => ({
      ...current,
      activeItem: next.activeTabId
        ? { kind: 'browser', tabId: next.activeTabId }
        : current.openTabs.at(-1)
          ? { kind: 'file', tabId: current.openTabs.at(-1)!.id }
          : firstOpenRightPanelTab(persistedWorkspace.tabs)
            ? { kind: 'function', type: firstOpenRightPanelTab(persistedWorkspace.tabs)! }
            : null,
    }))
  }
  const duplicateBrowser = (tabId: string) => {
    const next = duplicateBrowserTab(browserWorkspace, tabId)
    updateBrowserWorkspace(next)
    if (next.activeTabId) updateRuntime((current) => ({ ...current, activeItem: { kind: 'browser', tabId: next.activeTabId! } }))
  }
  const closeOtherBrowsers = (tabId: string) => {
    let next = browserWorkspace
    for (const tab of browserWorkspace.tabs) {
      if (tab.id === tabId) continue
      next = closeBrowserTab(next, tab.id)
      void browserRuntime({ method: 'close', params: { tabId: tab.id } }).catch(() => undefined)
    }
    next = activateBrowserTab(next, tabId)
    updateBrowserWorkspace(next)
    updateRuntime((current) => ({ ...current, activeItem: { kind: 'browser', tabId } }))
  }
  const restoreBrowser = () => {
    const next = restoreClosedBrowserTab(browserWorkspace)
    updateBrowserWorkspace(next)
    if (next.activeTabId) updateRuntime((current) => ({ ...current, activeItem: { kind: 'browser', tabId: next.activeTabId! } }))
  }
  const detachBrowser = (tabId: string): ThreadBrowserWorkspace => {
    const tabs = browserWorkspace.tabs.filter((tab) => tab.id !== tabId)
    const activeBrowserId = browserWorkspace.activeTabId === tabId ? tabs.at(-1)?.id : browserWorkspace.activeTabId
    return { tabs, recentlyClosed: browserWorkspace.recentlyClosed, ...(activeBrowserId ? { activeTabId: activeBrowserId } : {}) }
  }
  const moveBrowserToMain = (tabId: string) => {
    const tab = browserWorkspace.tabs.find((item) => item.id === tabId)
    if (!tab) return
    const source = detachBrowser(tabId)
    updateBrowserWorkspace(source)
    updateRuntime((current) => ({ ...current, activeItem: source.activeTabId ? { kind: 'browser', tabId: source.activeTabId } : null }))
    setTabs((current) => [...current.filter((item) => item.id !== tabId), { id: tabId, type: 'browser', title: tab.title || '浏览器', browserUrl: tab.url, threadId }])
    setActiveTabId(tabId)
  }
  const moveBrowserToThread = (tabId: string, targetThreadId: string) => {
    const tab = browserWorkspace.tabs.find((item) => item.id === tabId)
    if (!tab || targetThreadId === threadId) return
    const source = detachBrowser(tabId)
    setPersistedBrowserWorkspaces((current) => {
      const target = sanitizeThreadBrowserWorkspace(current[targetThreadId])
      return {
        ...current,
        [threadId]: source,
        [targetThreadId]: { ...target, tabs: [...target.tabs.filter((item) => item.id !== tabId), tab], activeTabId: tabId },
      }
    })
    void browserRuntime({ method: 'move-owner', params: { tabId, ownerThreadId: targetThreadId } }).catch(() => undefined)
    if (runtimeWorkspace.activeItem?.kind === 'browser' && runtimeWorkspace.activeItem.tabId === tabId) {
      updateRuntime((current) => ({ ...current, activeItem: source.activeTabId ? { kind: 'browser', tabId: source.activeTabId } : null }))
    }
  }

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
              browserTabs={browserWorkspace.tabs}
              activeItem={runtimeWorkspace.activeItem}
              reviewOpen={Boolean(codingReview)}
              reviewActive={codingReview?.active}
              onActivateReview={() => closeCodingReview({ type: 'activate', threadId })}
              onCloseReview={() => closeCodingReview({ type: 'close', threadId })}
              onActivateFunction={(fn) => {
                if (fn === 'browser') {
                  openBrowser()
                  return
                }
                closeCodingReview({ type: 'deactivate', threadId })
                action({ type: 'activate-function', threadId, function: fn, binding })
              }}
              onActivateFile={(tabId) => {
                closeCodingReview({ type: 'deactivate', threadId })
                updateRuntime((current) => ({ ...current, activeItem: { kind: 'file', tabId } }))
              }}
              onActivateBrowser={activateBrowser}
              onCloseFunction={(fn) => action({ type: 'close-function', threadId, function: fn })}
              onCloseFile={(tabId) => action({ type: 'close-file', threadId, tabId })}
              onCloseBrowser={closeBrowser}
              onDuplicateBrowser={duplicateBrowser}
              onCloseOtherBrowsers={closeOtherBrowsers}
              onMoveBrowserToMain={moveBrowserToMain}
              onMoveBrowserToThread={moveBrowserToThread}
              browserThreadTargets={threads.filter((item) => item.id !== threadId).map((item) => ({ id: item.id, label: item.title || '未命名任务' }))}
              onBrowserMenuOpenChange={(tabId, open) => {
                if (runtimeWorkspace.activeItem?.kind !== 'browser' || runtimeWorkspace.activeItem.tabId !== tabId) return
                void browserRuntime({ method: 'visible', params: { tabId, visible: !open } }).catch(() => undefined)
              }}
              canRestoreBrowser={browserWorkspace.recentlyClosed.length > 0}
              onRestoreBrowser={restoreBrowser}
              onOpenFunction={(fn) => {
                if (fn === 'browser') {
                  openBrowser()
                  return
                }
                closeCodingReview({ type: 'deactivate', threadId })
                action({ type: 'activate-function', threadId, function: fn, binding })
              }}
            />
            {hasOpenTabs ? (
              <RightPanelActiveContent
                runtime={runtimeWorkspace}
                browserWorkspace={browserWorkspace}
                workspaceSlug={workspaceSlug}
                workspaceProjectPath={agentWorkspace?.projectPath}
                fileContextId={binding.fileContextId}
                openFunctions={openFunctions}
                onRuntimeChange={updateRuntime}
                onBrowserWorkspaceChange={updateBrowserWorkspace}
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
                onOpen={(fn) => fn === 'browser' ? openBrowser() : action({ type: 'activate-function', threadId, function: fn, binding })}
              />
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function RightPanelActiveContent({ runtime, browserWorkspace, workspaceSlug, workspaceProjectPath, fileContextId, openFunctions, onRuntimeChange, onBrowserWorkspaceChange, threadId, codingReview, onOpenCodingFile }: {
  runtime: ThreadFileWorkspace
  browserWorkspace: ThreadBrowserWorkspace
  workspaceSlug?: string
  workspaceProjectPath?: string
  fileContextId?: string
  openFunctions: RightPanelFunction[]
  onRuntimeChange: (workspace: ThreadFileWorkspaceUpdate) => void
  onBrowserWorkspaceChange: (workspace: ThreadBrowserWorkspace) => void
  threadId: string
  codingReview?: CodingReviewPanelState
  onOpenCodingFile?: (path: string) => void
}) {
  if (codingReview?.active) {
    return <CodingReviewPanel threadId={threadId} state={codingReview} onOpenFile={onOpenCodingFile} />
  }
  const active = runtime.activeItem
  if (!active) return <PlaceholderRightPanelTab label="" />
  if (active.kind === 'browser') {
    const browserTab = browserWorkspace.tabs.find((tab) => tab.id === active.tabId)
    if (!browserTab) return <PlaceholderRightPanelTab label="浏览器标签已关闭" />
    return (
      <BrowserRightPanelTab
        threadId={threadId}
        tab={browserTab}
        onChange={(next) => onBrowserWorkspaceChange({
          ...browserWorkspace,
          tabs: browserWorkspace.tabs.map((item) => item.id === next.id ? next : item),
        })}
      />
    )
  }
  if (active.kind === 'file' || active.type === 'files') {
    return <FilesRightPanelWorkspace threadId={threadId} workspace={runtime} workspaceSlug={workspaceSlug} workspaceProjectPath={workspaceProjectPath} fileContextId={fileContextId} openFunctions={openFunctions} onWorkspaceChange={onRuntimeChange} />
  }
  return <PlaceholderRightPanelTab label={PLACEHOLDER_LABELS[active.type]} />
}
