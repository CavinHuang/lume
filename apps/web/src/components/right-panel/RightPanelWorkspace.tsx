import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  activeTabIdAtom,
  agentRuntimeEventsFamily,
  agentSideChatMapAtom,
  agentStreamingStatesFamily,
  agentThreadsAtom,
  agentWorkspacesAtom,
  codingReviewPanelActionAtom,
  codingReviewPanelsAtom,
  currentWorkspaceIdAtom,
  rightPanelFileWorkspacesAtom,
  rightPanelFileTabsAtom,
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
import { AgentMessages } from '../agent/AgentMessages'
import { AgentInput } from '../agent/AgentInput'
import { ThreadFileEnvProvider } from '../agent/thread-file-env'
import { FilesRightPanelWorkspace } from './FilesRightPanelWorkspace'
import { VaultRightPanelWorkspace } from './VaultRightPanelWorkspace'
import { CodingReviewPanel } from './CodingReviewPanel'
import { type CodingReviewPanelState } from '@/atoms'

const PLACEHOLDER_LABELS: Record<RightPanelFunction, string> = {
  files: '文件', chat: '问答', vault: 'Obsidian Vault',
}

type ThreadFileWorkspaceUpdate = ThreadFileWorkspace | ((current: ThreadFileWorkspace) => ThreadFileWorkspace)

export function RightPanelWorkspace({ maxWidth }: { maxWidth: number }) {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const persisted = useAtomValue(rightPanelWorkspacesAtom)
  const [runtime, setRuntime] = useAtom(rightPanelFileWorkspacesAtom)
  const [persistedFileTabs, setPersistedFileTabs] = useAtom(rightPanelFileTabsAtom)
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
          // #590:project 根目录已纳入 watcher，外部改动同样置 stale
          ? ['session', 'legacy', 'project']
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

  if (!threadId || !layout.open) return null

  const persistedWorkspace = sanitizeRightPanelWorkspace(persisted[threadId] ?? createEmptyRightPanelWorkspace())
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
          restoredTabs.find((tab) => tab.id === restoredActiveId)
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
    || Boolean(codingReview)
    || (runtimeWorkspace.activeItem?.kind === 'function' && runtimeWorkspace.activeItem.type === 'chat')

  const action = (value: Parameters<typeof dispatch>[0]) => dispatch(value)

  const compact = layout.mode === 'compact'
  const resolvedMaxWidth = Math.max(360, Math.round(maxWidth))
  const width = compact ? 72 : layout.mode === 'expanded'
    ? resolvedMaxWidth
    : Math.min(layout.width ?? RIGHT_PANEL_DEFAULT_WIDTH, resolvedMaxWidth)

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || compact) return
    event.preventDefault()
    // 面板内容承载 webview/iframe（独立文档，不向主文档冒泡 pointer 事件）：
    // 必须捕获指针，否则光标拖入其区域（宽度触到钳制值后极易发生）后
    // pointermove/pointerup 全部丢失——拖动冻结且 resizing 状态卡死
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => setLayout((current) => ({
      ...current, open: true, mode: 'normal',
      width: getRightPanelDragWidth({ clientX: next.clientX, viewportWidth: window.innerWidth, maxWidth: resolvedMaxWidth }),
    }))
    const stop = () => {
      setResizing(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    setResizing(true)
    move(event.nativeEvent)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
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
                runtime={runtimeWorkspace}
                workspaceSlug={workspaceSlug}
                workspaceProjectPath={agentWorkspace?.projectPath}
                fileContextId={binding.fileContextId}
                openFunctions={openFunctions}
                onRuntimeChange={updateRuntime}
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

function RightPanelActiveContent({ runtime, workspaceSlug, workspaceProjectPath, fileContextId, openFunctions, onRuntimeChange, threadId, codingReview, onOpenCodingFile }: {
  runtime: ThreadFileWorkspace
  workspaceSlug?: string
  workspaceProjectPath?: string
  fileContextId?: string
  openFunctions: RightPanelFunction[]
  onRuntimeChange: (workspace: ThreadFileWorkspaceUpdate) => void
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
  if (active.kind === 'function' && active.type === 'chat') {
    return <RightPanelSideChat threadId={threadId} workspaceSlug={workspaceSlug} fileContextId={fileContextId} />
  }
  if (active.kind === 'function' && active.type === 'vault') {
    return <VaultRightPanelWorkspace threadId={threadId} />
  }
  return <PlaceholderRightPanelTab label={PLACEHOLDER_LABELS[active.type]} />
}

/** 右侧面板 side-chat：基于 AgentMessages + AgentInput 组装的问答副窗口（见 #18） */
function RightPanelSideChat({ threadId, workspaceSlug, fileContextId }: { threadId: string; workspaceSlug?: string; fileContextId?: string }) {
  const sideChatThreadId = useAtomValue(agentSideChatMapAtom)[threadId]
  const streaming = useAtomValue(agentStreamingStatesFamily(sideChatThreadId ?? '')) === 'streaming'
  if (!sideChatThreadId) {
    return <PlaceholderRightPanelTab label="选中消息文字后点击「打开右侧问答」即可开始" />
  }
  return (
    <ThreadFileEnvProvider value={{ threadId: sideChatThreadId, workspaceSlug, fileContextId }}>
      <div className="flex h-full min-h-0 flex-col">
        <AgentMessages threadId={sideChatThreadId} streaming={streaming} />
        <AgentInput threadId={sideChatThreadId} streaming={streaming} />
      </div>
    </ThreadFileEnvProvider>
  )
}
