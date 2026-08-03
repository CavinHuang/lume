import { useAtomValue, useSetAtom } from 'jotai'
import { tabsAtom, activeTabIdAtom, clearTabDesktopContextTarget, setTabDesktopContextTarget } from '@/atoms'
import { AgentView } from '@/components/agent/AgentView'
import { AutomationManagementView } from '@/components/automation/AutomationManagementView'
import { LumeView } from '@/components/lume/LumeView'
import { ReadingView } from '@/components/reading/ReadingView'
import { SettingsView } from '@/components/settings/SettingsView'
import { SkillsMarketView } from '@/components/skills/SkillsMarketView'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { BrowserTabView } from './BrowserTabView'
import { TodoView } from '@/components/todo/TodoView'

export function TabContent() {
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  if (!activeTab) {
    return (
      <div className="flex-1 flex items-center justify-center text-foreground/30 text-sm">
        点击左侧「新会话」开始
      </div>
    )
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

  if (activeTab.type === 'settings') {
    return <SettingsView />
  }

  if (activeTab.type === 'automation') {
    return <AutomationManagementView />
  }

  if (activeTab.type === 'skills') {
    return <SkillsMarketView />
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

  return null
}
