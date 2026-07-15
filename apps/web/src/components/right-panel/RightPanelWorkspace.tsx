import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  activeTabIdAtom,
  agentThreadsAtom,
  agentWorkspacesAtom,
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

const PLACEHOLDER_LABELS: Record<RightPanelFunction, string> = {
  review: '审查', terminal: '终端', browser: '浏览器', files: '文件',
}

export function RightPanelWorkspace() {
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
  const workspaceId = thread?.workspaceId ?? currentWorkspaceId ?? undefined
  const workspaceSlug = agentWorkspaces.find((item) => item.id === workspaceId)?.slug
  const binding = useMemo(() => ({ workspaceId, fileContextId: thread?.fileContextId ?? thread?.id }), [workspaceId, thread?.fileContextId, thread?.id])

  useEffect(() => {
    const result = reconcileThreadFileWorkspaces(runtime, getEffectiveThreadFileBindings(threads, currentWorkspaceId).map((item) => ({
      ...item,
      openFunctions: getOpenRightPanelFunctions(sanitizeRightPanelWorkspace(persisted[item.id] ?? createEmptyRightPanelWorkspace()).tabs),
    })))
    if (result.revokedScopeTokens.length > 0
      || Object.keys(result.workspaces).length !== Object.keys(runtime).length
      || Object.entries(result.workspaces).some(([id, value]) => value !== runtime[id])) {
      setRuntime(result.workspaces)
      result.revokedScopeTokens.forEach((token) => void revokeFilePreviewScope(token).catch(() => undefined))
    }
  }, [currentWorkspaceId, persisted, threads])

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

  const updateRuntime = useCallback((next: ThreadFileWorkspace) => {
    if (!threadId) return
    setRuntime((current) => ({ ...current, [threadId]: next }))
  }, [setRuntime, threadId])

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
  const hasOpenTabs = firstOpenRightPanelTab(persistedWorkspace.tabs) !== null || runtimeWorkspace.openTabs.length > 0

  const updatePersisted = (next: ThreadRightPanelWorkspace) => setPersisted((current) => ({ ...current, [threadId]: next }))
  const action = (value: Parameters<typeof dispatch>[0]) => dispatch(value)

  const compact = layout.mode === 'compact'
  const width = compact ? '72px' : layout.mode === 'expanded'
    ? 'min(900px, 70vw)'
    : `clamp(360px, ${layout.width ?? RIGHT_PANEL_DEFAULT_WIDTH}px, min(900px, 70vw))`

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || compact) return
    event.preventDefault()
    const move = (next: PointerEvent) => setLayout((current) => ({
      ...current, open: true, mode: 'normal',
      width: getRightPanelDragWidth({ clientX: next.clientX, viewportWidth: window.innerWidth }),
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
    <aside className={cn('relative z-[60] flex h-full shrink-0 flex-col border-l border-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)] pb-2 pr-2 transition-[width] duration-200', resizing && 'transition-none')} style={{ width }}>
      {!compact && <div role="separator" aria-orientation="vertical" aria-label="调整右侧面板宽度" onPointerDown={startResize} className="absolute left-0 top-0 z-20 h-full w-2 -translate-x-1 cursor-col-resize touch-none" />}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)]">
        {compact ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-[var(--lume-text-muted)]"><PanelRightOpen size={18} /></div>
        ) : (
          <>
            <RightPanelTabBar
              workspace={persistedWorkspace}
              fileTabs={runtimeWorkspace.openTabs}
              activeItem={runtimeWorkspace.activeItem}
              onActivateFunction={(fn) => action({ type: 'activate-function', threadId, function: fn, binding })}
              onActivateFile={(tabId) => updateRuntime({ ...runtimeWorkspace, activeItem: { kind: 'file', tabId } })}
              onCloseFunction={(fn) => action({ type: 'close-function', threadId, function: fn })}
              onCloseFile={(tabId) => action({ type: 'close-file', threadId, tabId })}
              onOpenFunction={(fn) => action({ type: 'activate-function', threadId, function: fn, binding })}
            />
            {hasOpenTabs ? (
              <RightPanelActiveContent
                persisted={persistedWorkspace}
                runtime={runtimeWorkspace}
                workspaceSlug={workspaceSlug}
                fileContextId={binding.fileContextId}
                openFunctions={openFunctions}
                onRuntimeChange={updateRuntime}
                onPersistedChange={updatePersisted}
              />
            ) : <RightPanelLauncher onOpen={(fn) => action({ type: 'activate-function', threadId, function: fn, binding })} />}
          </>
        )}
      </div>
    </aside>
  )
}

function RightPanelActiveContent({ persisted, runtime, workspaceSlug, fileContextId, openFunctions, onRuntimeChange, onPersistedChange }: {
  persisted: ThreadRightPanelWorkspace
  runtime: ThreadFileWorkspace
  workspaceSlug?: string
  fileContextId?: string
  openFunctions: RightPanelFunction[]
  onRuntimeChange: (workspace: ThreadFileWorkspace) => void
  onPersistedChange: (workspace: ThreadRightPanelWorkspace) => void
}) {
  const active = runtime.activeItem
  if (!active) return <PlaceholderRightPanelTab label="" />
  if (active.kind === 'file' || active.type === 'files') {
    return <FilesRightPanelWorkspace workspace={runtime} workspaceSlug={workspaceSlug} fileContextId={fileContextId} openFunctions={openFunctions} onWorkspaceChange={onRuntimeChange} />
  }
  const tabState = persisted.tabs[active.type]
  if (tabState?.type === 'browser') {
    return <BrowserRightPanelTab state={tabState} onChange={(next) => onPersistedChange({ tabs: { ...persisted.tabs, browser: next } })} />
  }
  return <PlaceholderRightPanelTab label={PLACEHOLDER_LABELS[active.type]} />
}
