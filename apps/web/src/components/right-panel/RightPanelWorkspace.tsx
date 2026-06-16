import { useAtom, useAtomValue } from 'jotai'
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
import { RightPanelLauncher } from './RightPanelLauncher'
import { RightPanelTabBar } from './RightPanelTabBar'
import { PlaceholderRightPanelTab } from './PlaceholderRightPanelTab'
import { FilesRightPanelTab } from './FilesRightPanelTab'

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
  const layout = useAtomValue(rightPanelLayoutAtom)
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

  return (
    <aside className={cn(
      'relative z-[60] flex h-full shrink-0 flex-col border-l border-border/70 bg-background pb-2 pr-2 pt-5 transition-[width] duration-200',
      layout.mode === 'expanded' && 'w-[760px]',
      layout.mode === 'normal' && 'w-[520px]',
      compact && 'w-[72px]',
    )}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border/60 bg-background">
        {compact ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-foreground/38">
            <PanelRightOpen size={18} />
          </div>
        ) : hasOpenTabs ? (
          <>
            <RightPanelTabBar
              workspace={workspace}
              onActivate={activateFunction}
              onClose={closeFunction}
              onOpen={openFunction}
            />
            <RightPanelActiveTab
              workspace={workspace}
              threadId={threadId}
              workspaceSlug={workspaceSlug}
              onChange={updateWorkspace}
            />
          </>
        ) : (
          <RightPanelLauncher onOpen={openFunction} />
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

  return <PlaceholderRightPanelTab label={PLACEHOLDER_LABELS[activeTab]} />
}
