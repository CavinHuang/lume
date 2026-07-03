import { useAtom } from 'jotai'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { tabsAtom, activeTabIdAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'

export function TabBar() {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)

  const closeTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setTabs((prev) => prev.filter((t) => t.id !== id))
    if (activeTabId === id) {
      const remaining = tabs.filter((t) => t.id !== id)
      setActiveTabId(remaining.at(-1)?.id ?? null)
    }
  }

  if (tabs.length === 0) return null

  return (
    <ScrollArea className="w-full" orientation="horizontal">
      <div className="flex w-max min-w-full items-center gap-1 px-2 pt-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-t-lg border border-transparent px-3 py-1.5 text-[13px] whitespace-nowrap transition-[background-color,border-color,color] duration-150 ease-out',
              activeTabId === tab.id
                ? 'border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)] shadow-[0_10px_28px_-24px_hsl(var(--lume-shadow-panel)/0.5)]'
                : 'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-secondary)]'
            )}
          >
            <span className="max-w-[140px] truncate">{tab.title}</span>
            <span
              role="button"
              onClick={(e) => closeTab(tab.id, e)}
              className="size-4 flex items-center justify-center rounded text-[var(--lume-text-muted)] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-text-primary)]"
            >
              <X size={11} />
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  )
}
