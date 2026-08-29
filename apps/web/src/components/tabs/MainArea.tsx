import { useAtomValue } from 'jotai'
import { activeTabIdAtom, tabsAtom } from '@/atoms'
import { SettingsView } from '@/components/settings/SettingsView'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'

export function MainArea() {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  // 设置是整页视图：激活时不渲染 TabBar，直接占满主面板
  if (activeTab?.type === 'settings') {
    return <SettingsView />
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--lume-bg-panel)]">
      <TabBar />
      <div className="flex-1 min-h-0 flex bg-[var(--lume-bg-panel)]">
        <TabContent />
      </div>
    </div>
  )
}
