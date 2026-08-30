/**
 * 浏览器标签总览弹层 —— ZCode jkt(cmdk 总览)语义的 Lume 落法。
 *
 * 语义来源:.zcode/analysis/sidepane/P1-shell-architecture.md §3.4:
 *   标签总览弹层 = 搜索 + "打开/最近关闭" 两组 + 相对时间(每分钟刷新)。
 * Lume 落法:cmdk 未引入(AGENTS.md 不新增依赖),用 ui/dialog + ui/input 搭
 * 同构交互——输入过滤、↑↓ 移动、Enter 确认、悬停同步高亮;打开 tab 走 selectTab,
 * 关闭 tab 走 reopenClosedTab(换新 tabId)。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Globe } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatRelativeTime, matchesTabQuery } from './browser-panel-logic'
import type { UseBrowserPanelResult } from './useBrowserPanel'

interface OverviewItem {
  key: string
  kind: 'open' | 'closed'
  label: string
  /** 辅助列:打开 tab 显示 URL,关闭 tab 显示相对时间。 */
  detail: string | null
  faviconUrl: string | null
  tabId?: string
  closedId?: string
}

export function TabOverviewDialog({ open, onOpenChange, panel }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  panel: UseBrowserPanelResult
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const listRef = useRef<HTMLDivElement | null>(null)

  /** 打开时复位搜索/高亮;打开期间每分钟刷新相对时间(ZCode 每分钟刷新)。 */
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const openItems = useMemo<OverviewItem[]>(() => panel.tabs
    .filter((tab) => matchesTabQuery(query, [tab.title, tab.url]))
    .map((tab) => ({
      key: `open:${tab.tabId}`,
      kind: 'open' as const,
      label: tab.title?.trim() || tab.url || '新标签页',
      detail: tab.url && tab.url !== 'about:blank' ? tab.url : null,
      faviconUrl: tab.faviconUrl,
      tabId: tab.tabId,
    })), [panel.tabs, query])

  const closedItems = useMemo<OverviewItem[]>(() => panel.closedTabs
    .filter((entry) => matchesTabQuery(query, [entry.title, entry.url]))
    .map((entry) => ({
      key: `closed:${entry.id}`,
      kind: 'closed' as const,
      label: entry.title?.trim() || entry.url || '新标签页',
      detail: formatRelativeTime(entry.closedAt, now),
      faviconUrl: entry.faviconUrl,
      closedId: entry.id,
    })), [now, panel.closedTabs, query])

  const items = useMemo(() => [...openItems, ...closedItems], [closedItems, openItems])

  useEffect(() => {
    if (activeIndex > 0 && activeIndex >= items.length) setActiveIndex(0)
  }, [activeIndex, items.length])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-overview-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, items, open])

  const choose = (item: OverviewItem | undefined) => {
    if (!item) return
    onOpenChange(false)
    if (item.kind === 'open' && item.tabId) panel.selectTab(item.tabId)
    if (item.kind === 'closed' && item.closedId) panel.reopenClosedTab(item.closedId)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, items.length - 1)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(items[activeIndex])
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-16 max-w-md translate-y-0 gap-2 p-3">
        <DialogTitle className="sr-only">标签页总览</DialogTitle>
        <Input
          value={query}
          placeholder="搜索标签页…"
          className="h-8 rounded-lg"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div ref={listRef} role="listbox" aria-label="标签页列表" className="max-h-72 min-h-0 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的标签页</div>
          ) : (
            <>
              {openItems.length > 0 ? (
                <>
                  <OverviewGroupLabel>打开的标签页</OverviewGroupLabel>
                  {openItems.map((item) => (
                    <OverviewRow
                      key={item.key}
                      item={item}
                      index={items.indexOf(item)}
                      activeIndex={activeIndex}
                      onHover={setActiveIndex}
                      onChoose={choose}
                    />
                  ))}
                </>
              ) : null}
              {closedItems.length > 0 ? (
                <>
                  <OverviewGroupLabel>最近关闭</OverviewGroupLabel>
                  {closedItems.map((item) => (
                    <OverviewRow
                      key={item.key}
                      item={item}
                      index={items.indexOf(item)}
                      activeIndex={activeIndex}
                      onHover={setActiveIndex}
                      onChoose={choose}
                    />
                  ))}
                </>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function OverviewGroupLabel({ children }: { children: string }) {
  return <div className="px-2 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">{children}</div>
}

function OverviewRow({ item, index, activeIndex, onHover, onChoose }: {
  item: OverviewItem
  index: number
  activeIndex: number
  onHover: (index: number) => void
  onChoose: (item: OverviewItem) => void
}) {
  const active = index === activeIndex
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-overview-active={active ? 'true' : undefined}
      onMouseEnter={() => onHover(index)}
      onClick={() => onChoose(item)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {item.faviconUrl ? (
        <img src={item.faviconUrl} alt="" className="size-3.5 shrink-0 rounded-sm object-contain" draggable={false} referrerPolicy="no-referrer" />
      ) : (
        <Globe className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.detail ? <span className="max-w-32 shrink-0 truncate text-[10px] opacity-70">{item.detail}</span> : null}
    </button>
  )
}
