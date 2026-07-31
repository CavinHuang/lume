import { BrowserShell } from '@/components/browser/BrowserShell'
import type { RightPanelBrowserTab } from './right-panel-browser-state'

export function BrowserRightPanelTab({ threadId, tab, onChange }: {
  threadId: string
  tab: RightPanelBrowserTab
  onChange: (next: RightPanelBrowserTab) => void
}) {
  return (
    <BrowserShell
      tabId={tab.id}
      ownerThreadId={threadId}
      initialUrl={tab.url}
      initialZoomFactor={tab.zoomFactor}
      initialViewport={tab.viewport}
      initialNavigationEntries={tab.navigationEntries}
      initialNavigationIndex={tab.navigationIndex}
      initialScrollPosition={tab.scrollPosition}
      surface="right-panel"
      onDescriptorChange={(descriptor) => onChange({
        ...tab,
        url: descriptor.url,
        title: descriptor.title || '新标签页',
        faviconUrl: descriptor.faviconUrl,
        lastOpenedAt: descriptor.lastOpenedAt ?? tab.lastOpenedAt,
        zoomFactor: descriptor.zoomFactor ?? tab.zoomFactor,
        viewport: descriptor.viewport,
        navigationEntries: descriptor.navigationEntries,
        navigationIndex: descriptor.navigationIndex,
        scrollPosition: descriptor.scrollPosition,
      })}
    />
  )
}
