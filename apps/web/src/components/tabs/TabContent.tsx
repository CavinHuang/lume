import { useAtomValue, useSetAtom } from 'jotai'
import { activeTabIdAtom, clearTabDesktopContextTarget, setTabDesktopContextTarget, tabsAtom } from '@/atoms'
import { AgentView } from '@/components/agent/AgentView'
import { AutomationManagementView } from '@/components/automation/AutomationManagementView'
import { LumeView } from '@/components/lume/LumeView'
import { ProactiveHub } from '@/components/proactive/ProactiveHub'
import { ReadingView } from '@/components/reading/ReadingView'
import { SkillsMarketView } from '@/components/skills/SkillsMarketView'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { VaultRightPanelWorkspace } from '@/components/right-panel/VaultRightPanelWorkspace'
import { BrowserTabView } from './BrowserTabView'
import { TodoView } from '@/components/todo/TodoView'

export function TabContent() {
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  if (!activeTab) {
    // 启动时持久化的 activeTabId 对应的标签尚未入列：选中的会话直接加载，否则直接进欢迎页，不再显示占位提示
    if (activeTabId && !activeTabId.startsWith('__')) {
      return <AgentView threadId={activeTabId} />
    }
    return <WelcomeView />
  }

  if (activeTab.type === 'welcome') {
    return <WelcomeView workspaceId={activeTab.workspaceId} desktopContextTarget={activeTab.desktopContextTarget} />
  }

  if (activeTab.type === 'agent' && activeTab.threadId) {
    return (
      <AgentView
        threadId={activeTab.threadId}
        readOnly={activeTab.readOnly}
        desktopContextTarget={activeTab.desktopContextTarget}
        onSelectDesktopContextTarget={(target) => {
          setTabs((prev) => setTabDesktopContextTarget(prev, activeTab.id, target))
        }}
        onClearDesktopContextTarget={() => {
          setTabs((prev) => clearTabDesktopContextTarget(prev, activeTab.id))
        }}
      />
    )
  }

  if (activeTab.type === 'automation') {
    return <AutomationManagementView />
  }

  if (activeTab.type === 'skills') {
    return <SkillsMarketView />
  }

  if (activeTab.type === 'vault') {
    return <VaultRightPanelWorkspace />
  }

  if (activeTab.type === 'reading') {
    return <ReadingView />
  }

  if (activeTab.type === 'lume') {
    return <LumeView />
  }

  if (activeTab.type === 'browser') {
    return <BrowserTabView tab={activeTab} />
  }

  if (activeTab.type === 'todo') return <TodoView workspaceId={activeTab.workspaceId} todoId={activeTab.todoId} initialTitle={activeTab.todoPrefill} />

  if (activeTab.type === 'proactive') {
    return <ProactiveHub />
  }

  return null
}
