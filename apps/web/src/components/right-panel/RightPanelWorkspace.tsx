import { useAtom, useAtomValue } from 'jotai'
import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  activeTabIdAtom,
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  rightPanelLayoutAtom,
  rightPanelWorkspacesAtom,
  tabsAtom,
} from '@/atoms'
import { PanelRightOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  closeRightPanelTab,
  createEmptyRightPanelWorkspace,
  firstOpenRightPanelTab,
  openRightPanelTab,
  sanitizeRightPanelWorkspace,
  type RightPanelFunction,
  type ThreadRightPanelWorkspace,
} from './right-panel-state'
import { RIGHT_PANEL_DEFAULT_WIDTH, getRightPanelDragWidth } from './right-panel-layout'
import { RightPanelLauncher } from './RightPanelLauncher'
import { RightPanelTabBar } from './RightPanelTabBar'
import { PlaceholderRightPanelTab } from './PlaceholderRightPanelTab'
import { FilesRightPanelTab } from './FilesRightPanelTab'
import { BrowserRightPanelTab } from './BrowserRightPanelTab'

const PLACEHOLDER_LABELS: Record<RightPanelFunction, string> = {
  review: '审查',
  terminal: '终端',
  browser: '浏览器',
  files: '文件',
}

export function RightPanelWorkspace() {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const [workspaces, setWorkspaces] = useAtom(rightPanelWorkspacesAtom)
  const [layout, setLayout] = useAtom(rightPanelLayoutAtom)
  const [resizing, setResizing] = useState(false)
  const threads = useAtomValue(agentThreadsAtom)
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const threadId = activeTab?.type === 'agent' ? activeTab.threadId : undefined
  const workspaceSlug = (() => {
    const thread = threads.find((item) => item.id === threadId)
    const workspaceId = thread?.workspaceId ?? currentWorkspaceId
    return agentWorkspaces.find((item) => item.id === workspaceId)?.slug
  })()

  if (!threadId || !layout.open) {
    return null
  }

  const workspace = sanitizeRightPanelWorkspace(workspaces[threadId] ?? createEmptyRightPanelWorkspace())
  const hasOpenTabs = firstOpenRightPanelTab(workspace.tabs) !== null

  const updateWorkspace = (nextWorkspace: ThreadRightPanelWorkspace) => {
    setWorkspaces((prev) => ({
      ...prev,
      [threadId]: nextWorkspace,
    }))
  }

  const openFunction = (type: RightPanelFunction) => {
    updateWorkspace(openRightPanelTab(workspace, type))
  }

  const activateFunction = (type: RightPanelFunction) => {
    if (!workspace.tabs[type]) return
    updateWorkspace({ ...workspace, activeTab: type })
  }

  const closeFunction = (type: RightPanelFunction) => {
    updateWorkspace(closeRightPanelTab(workspace, type))
  }

  const compact = layout.mode === 'compact'
  const width = compact
    ? '72px'
    : layout.mode === 'expanded'
      ? 'min(900px, 70vw)'
      : `clamp(360px, ${layout.width ?? RIGHT_PANEL_DEFAULT_WIDTH}px, min(900px, 70vw))`

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || compact) return
    event.preventDefault()

    const setWidthFromPointer = (clientX: number) => {
      setLayout((current) => ({
        ...current,
        open: true,
        mode: 'normal',
        width: getRightPanelDragWidth({ clientX, viewportWidth: window.innerWidth }),
      }))
    }

    const handlePointerMove = (nextEvent: PointerEvent) => {
      setWidthFromPointer(nextEvent.clientX)
    }

    const stopResize = () => {
      setResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setWidthFromPointer(event.clientX)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }

  return (
    <aside className={cn(
      'relative z-[60] flex h-full shrink-0 flex-col border-l border-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)] pb-2 pr-2 transition-[width] duration-200 ease-out',
      resizing && 'transition-none',
    )}
      style={{ width }}
    >
      {!compact && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧面板宽度"
          title="拖动调整右侧面板宽度"
          onPointerDown={startResize}
          className="absolute left-0 top-0 z-20 h-full w-2 -translate-x-1 cursor-col-resize touch-none transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_14%,transparent)]"
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)]">
        {compact ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-[var(--lume-text-muted)]">
            <PanelRightOpen size={18} />
          </div>
        ) : (
          <>
            <RightPanelTabBar
              workspace={workspace}
              onActivate={activateFunction}
              onClose={closeFunction}
              onOpen={openFunction}
            />
            {hasOpenTabs ? (
              <RightPanelActiveTab
                workspace={workspace}
                threadId={threadId}
                workspaceSlug={workspaceSlug}
                onChange={updateWorkspace}
              />
            ) : (
              <RightPanelLauncher onOpen={openFunction} />
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function RightPanelActiveTab({
  onChange,
  threadId,
  workspace,
  workspaceSlug,
}: {
  onChange: (next: ThreadRightPanelWorkspace) => void
  threadId: string
  workspace: ThreadRightPanelWorkspace
  workspaceSlug?: string
}) {
  const activeTab = workspace.activeTab
  if (!activeTab || !workspace.tabs[activeTab]) {
    return <PlaceholderRightPanelTab label="" />
  }

  const tabState = workspace.tabs[activeTab]
  if (tabState?.type === 'files') {
    return (
      <FilesRightPanelTab
        state={tabState}
        threadId={threadId}
        workspaceSlug={workspaceSlug}
        onChange={(nextTab) => {
          onChange({
            activeTab: 'files',
            tabs: {
              ...workspace.tabs,
              files: nextTab,
            },
          })
        }}
      />
    )
  }

  if (tabState?.type === 'browser') {
    return (
      <BrowserRightPanelTab
        state={tabState}
        onChange={(nextTab) => {
          onChange({
            activeTab: 'browser',
            tabs: {
              ...workspace.tabs,
              browser: nextTab,
            },
          })
        }}
      />
    )
  }

  return <PlaceholderRightPanelTab label={PLACEHOLDER_LABELS[activeTab]} />
}
