import { useAtom } from 'jotai'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { tabsAtom, activeTabIdAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'

import { Button } from '@/components/ui/button'
import { ThreadTabContextMenu } from './ThreadTabContextMenu'
export function TabBar() {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  // 设置是整页视图，不作为 tab 芯片出现
  const visibleTabs = tabs.filter((tab) => tab.type !== 'settings')

  const closeTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setTabs((prev) => prev.filter((t) => t.id !== id))
    if (activeTabId === id) {
      const remaining = tabs.filter((t) => t.id !== id && t.type !== 'settings')
      setActiveTabId(remaining.at(-1)?.id ?? null)
    }
  }

  if (visibleTabs.length === 0) return null

  return (
    <ScrollArea className="w-full" orientation="horizontal">
      <div className="flex w-max min-w-full items-center gap-1 px-2 pt-2">
        {visibleTabs.map((tab) => {
          const button = (
            <Button
              variant="ghost"
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-t-lg border border-transparent px-3 py-1.5 text-[13px] whitespace-nowrap transition-[background-color,border-color,color] duration-150 ease-out',
                activeTabId === tab.id
                  ? 'border-[color:color-mix(in_oklab,var(--brand)_28%,var(--border))] bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)] shadow-[0_10px_28px_-24px_hsl(var(--lume-shadow-panel)/0.5)]'
                  : 'text-[var(--lume-text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--lume-text-secondary)]'
              )}
            >
              <span className="max-w-[140px] truncate">{tab.title}</span>
              <span
                role="button"
                onClick={(e) => closeTab(tab.id, e)}
                className="pointer-events-none size-4 flex items-center justify-center rounded text-[var(--lume-text-muted)] opacity-0 transition group-hover/button:pointer-events-auto group-hover/button:opacity-100 hover:bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] hover:text-[var(--brand)]"
              >
                <X size={11} />
              </span>
            </Button>
          )
          if (tab.type === 'agent') {
            return (
              <ThreadTabContextMenu key={tab.id} threadId={tab.threadId ?? tab.id} readOnly={tab.readOnly}>
                {button}
              </ThreadTabContextMenu>
            )
          }
          return button
        })}
      </div>
    </ScrollArea>
  )
}
