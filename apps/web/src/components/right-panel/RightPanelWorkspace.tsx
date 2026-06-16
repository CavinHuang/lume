import { useAtom, useAtomValue } from 'jotai'
import { activeTabIdAtom, rightPanelWorkspacesAtom, tabsAtom } from '@/atoms'
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
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const threadId = activeTab?.type === 'agent' ? activeTab.threadId : undefined

  if (!threadId) {
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

  return (
    <aside className="relative z-[60] flex h-full w-[520px] shrink-0 flex-col border-l border-border/70 bg-background pb-2 pr-2 pt-5">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border/60 bg-background">
        {hasOpenTabs ? (
          <>
            <RightPanelTabBar
              workspace={workspace}
              onActivate={activateFunction}
              onClose={closeFunction}
              onOpen={openFunction}
            />
            <RightPanelActiveTab workspace={workspace} />
          </>
        ) : (
          <RightPanelLauncher onOpen={openFunction} />
        )}
      </div>
    </aside>
  )
}

function RightPanelActiveTab({ workspace }: { workspace: ThreadRightPanelWorkspace }) {
  const activeTab = workspace.activeTab
  if (!activeTab || !workspace.tabs[activeTab]) {
    return <PlaceholderRightPanelTab label="" />
  }

  return <PlaceholderRightPanelTab label={PLACEHOLDER_LABELS[activeTab]} />
}
