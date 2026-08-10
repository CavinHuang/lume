import type { Tab } from '@/atoms/tab-atoms'
import type { MemoryCenterDeepLink } from './memory-center-state'

export const MEMORY_CENTER_TAB_ID = '__proactive__'

export function upsertMemoryCenterTab(tabs: Tab[]): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === MEMORY_CENTER_TAB_ID)
  if (index < 0) {
    return [
      ...tabs,
      { id: MEMORY_CENTER_TAB_ID, type: 'proactive', title: '记忆与洞察' },
    ]
  }
  if (tabs[index]?.title === '记忆与洞察') return tabs
  return tabs.map((tab, tabIndex) => (
    tabIndex === index ? { ...tab, title: '记忆与洞察' } : tab
  ))
}

export function memoryCenterTarget(
  target?: MemoryCenterDeepLink,
): MemoryCenterDeepLink {
  return target ?? { section: 'attention' }
}
