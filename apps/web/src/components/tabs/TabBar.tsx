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
              'flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-[13px] whitespace-nowrap transition-colors',
              activeTabId === tab.id
                ? 'bg-white dark:bg-zinc-800 text-foreground shadow-sm'
                : 'text-foreground/60 hover:text-foreground hover:bg-white/50 dark:hover:bg-zinc-800/50'
            )}
          >
            <span className="max-w-[140px] truncate">{tab.title}</span>
            <span
              role="button"
              onClick={(e) => closeTab(tab.id, e)}
              className="size-4 flex items-center justify-center rounded hover:bg-foreground/10 text-foreground/40 hover:text-foreground/70"
            >
              <X size={11} />
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  )
}
