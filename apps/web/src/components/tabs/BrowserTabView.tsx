import { useSetAtom } from 'jotai'
import { tabsAtom, type Tab } from '@/atoms'
import { BrowserShell } from '@/components/browser/BrowserShell'
export { normalizeUrl } from '@/components/browser/browser-url'
interface BrowserTabViewProps {
  tab: Tab
}

export function BrowserTabView({ tab }: BrowserTabViewProps) {
  const setTabs = useSetAtom(tabsAtom)
  return (
    <BrowserShell
      tabId={tab.id}
      initialUrl={tab.browserUrl ?? ''}
      ownerThreadId={tab.threadId}
      surface="main"
      className="bg-[#171717] text-white"
      onDescriptorChange={(descriptor) => setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, browserUrl: undefined, title: descriptor.title || '浏览器' } : item))}
    />
  )
}
