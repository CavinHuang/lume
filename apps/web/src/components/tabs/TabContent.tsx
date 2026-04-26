import { useAtomValue } from 'jotai'
import { tabsAtom, activeTabIdAtom } from '@/atoms'
import { AgentView } from '@/components/agent/AgentView'
import { AutomationManagementView } from '@/components/automation/AutomationManagementView'
import { SettingsView } from '@/components/settings/SettingsView'
import { SkillsMarketView } from '@/components/skills/SkillsMarketView'
import { WelcomeView } from '@/components/welcome/WelcomeView'

export function TabContent() {
  const tabs = useAtomValue(tabsAtom)
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
    return <WelcomeView workspaceId={activeTab.workspaceId} />
  }

  if (activeTab.type === 'agent' && activeTab.threadId) {
    return <AgentView threadId={activeTab.threadId} />
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

  return null
}
