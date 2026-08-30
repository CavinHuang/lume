/**
 * 浏览器面板标签条 —— ZCode yAt 标签条语义的 Lume 落法。
 *
 * 语义来源:docs/analysis/zcode-sidepane-consolidated.md §2、
 * .zcode/analysis/sidepane/P1-shell-architecture.md §3.4:
 *  - dnd-kit 拖拽重排(DndContext activation distance 4px + horizontal 策略),
 *    onDragEnd 产出全量 id 序列交面板 reorderTabs(Ade:不动选中);
 *  - 溢出估宽 Xkt:tabs*60px + gap*8px,超 viewport 视为溢出 → "+" 移到右侧独立区、
 *    出现总览入口(chevron);左右渐隐 mask 由滚动位置驱动(Ie.left/right);
 *  - agent 操作中(operationUntil 未到期)favicon 槽位让位呼吸点指示
 *    (ZCode _kt,browser-use-operation-breathe 动画),空闲恢复 favicon;
 *  - DOM 标记:data-side-pane-tabs-viewport/-content、data-side-pane-tab-id、
 *    data-state=active|inactive、data-browser-tab-residency、
 *    data-browser-use-operation-indicator(测试/上下文钩子)。
 *
 * UI 约定:一律使用 components/ui 的 shadcn 原子组件(AGENTS.md);文案为内联中文。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, Globe, Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isTabStripOverflowing, reorderedByIds } from './browser-panel-logic'
import type { BrowserPanelTab, UseBrowserPanelResult } from './useBrowserPanel'
import { useOperationWindowActive } from './useBrowserResizeWarning'
import { TabOverviewDialog } from './TabOverviewDialog'

/** 渐隐 mask 带宽(px)。 */
const TAB_FADE_PX = 24
/** 拖拽落下后吞掉的误点击窗口(ms;拖拽结束的 pointerup 会补发 click)。 */
const DRAG_CLICK_SUPPRESS_MS = 200

export function BrowserTabStrip({ panel }: { panel: UseBrowserPanelResult }) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [scrollFades, setScrollFades] = useState({ left: false, right: false })
  const [overviewOpen, setOverviewOpen] = useState(false)
  const dragEndedAtRef = useRef(0)

  const overflow = isTabStripOverflowing(panel.tabs.length, viewportWidth)
  const tabIds = useMemo(() => panel.tabs.map((tab) => tab.tabId), [panel.tabs])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  /** viewport 宽度观察(Xkt 溢出估宽的输入;ResizeObserver 缺席时退化为不溢出)。 */
  useEffect(() => {
    const node = viewportRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0)
      setViewportWidth((current) => (current === width ? current : width))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const syncFades = useCallback(() => {
    const node = viewportRef.current
    if (!node) return
    const left = node.scrollLeft > 1
    const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 1
    setScrollFades((current) => (current.left === left && current.right === right ? current : { left, right }))
  }, [])

  useEffect(syncFades, [panel.tabs, syncFades])
  useEffect(syncFades, [overflow, syncFades, viewportWidth])

  /** 拖拽落下后短暂吞掉补发的 click(否则落点 tab 会被误选中)。 */
  const isClickSuppressed = useCallback(() => Date.now() - dragEndedAtRef.current < DRAG_CLICK_SUPPRESS_MS, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    dragEndedAtRef.current = Date.now()
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = tabIds.indexOf(String(active.id))
    const newIndex = tabIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const orderedIds = reorderedByIds(tabIds, arrayMove([...tabIds], oldIndex, newIndex))
    if (orderedIds) panel.reorderTabs(orderedIds)
  }, [panel, tabIds])

  const maskImage = scrollFades.left && scrollFades.right
    ? `linear-gradient(to right, transparent 0, #000 ${TAB_FADE_PX}px, #000 calc(100% - ${TAB_FADE_PX}px), transparent 100%)`
    : scrollFades.left
      ? `linear-gradient(to right, transparent 0, #000 ${TAB_FADE_PX}px)`
      : scrollFades.right
        ? `linear-gradient(to right, #000 calc(100% - ${TAB_FADE_PX}px), transparent 100%)`
        : undefined

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border">
      <div className="relative min-w-0 flex-1">
        <div
          ref={viewportRef}
          data-side-pane-tabs-viewport=""
          onScroll={syncFades}
          style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
          className="h-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
              <div data-side-pane-tabs-content="" className="flex h-full items-center gap-2 px-1.5">
                {panel.tabs.map((tab) => (
                  <BrowserTabButton
                    key={tab.tabId}
                    tab={tab}
                    selected={tab.tabId === panel.selectedTabId}
                    panel={panel}
                    isClickSuppressed={isClickSuppressed}
                  />
                ))}
                {!overflow ? <AddTabButton onClick={() => panel.openUrlTab('about:blank')} /> : null}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </div>
      {overflow ? (
        <div className="flex shrink-0 items-center gap-0.5 pl-0.5 pr-1.5">
          <AddTabButton onClick={() => panel.openUrlTab('about:blank')} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="标签页总览"
            title="标签页总览"
            onClick={() => setOverviewOpen(true)}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <TabOverviewDialog open={overviewOpen} onOpenChange={setOverviewOpen} panel={panel} />
    </div>
  )
}

function AddTabButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="shrink-0"
      aria-label="新建浏览器标签页"
      title="新建浏览器标签页"
      onClick={onClick}
    >
      <Plus className="size-3.5" aria-hidden="true" />
    </Button>
  )
}

function BrowserTabButton({ tab, selected, panel, isClickSuppressed }: {
  tab: BrowserPanelTab
  selected: boolean
  panel: UseBrowserPanelResult
  isClickSuppressed: () => boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.tabId })
  // agent 操作窗(eEt 倒计时):favicon 槽位让位呼吸指示,空闲恢复 favicon(ZCode _kt)。
  const operationActive = useOperationWindowActive(tab.operationUntil)
  const label = tab.title?.trim() || tab.url || '新标签页'
  const guardClick = (action: () => void) => () => {
    if (isClickSuppressed()) return
    action()
  }
  return (
    <div
      ref={setNodeRef}
      data-side-pane-tab-id={tab.tabId}
      data-state={selected ? 'active' : 'inactive'}
      data-browser-tab-residency={tab.residency}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group flex h-7 shrink-0 touch-none select-none items-center gap-1.5 rounded-lg border px-1.5 text-xs font-medium',
        isDragging && 'z-10 shadow-md',
        selected ? 'border-border bg-accent text-accent-foreground shadow-sm' : 'border-transparent text-muted-foreground hover:bg-muted',
      )}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        className="flex min-w-0 max-w-40 flex-1 items-center gap-1.5"
        title={label}
        onClick={guardClick(() => panel.selectTab(tab.tabId))}
      >
        {operationActive ? (
          <span
            aria-hidden="true"
            data-browser-use-operation-indicator="active"
            className="browser-use-operation-breathe inline-flex size-3.5 shrink-0 items-center justify-center"
          >
            <span className="size-1.5 rounded-full bg-amber-500" />
          </span>
        ) : tab.faviconUrl ? (
          <img src={tab.faviconUrl} alt="" className="size-3.5 shrink-0 rounded-sm object-contain" draggable={false} referrerPolicy="no-referrer" />
        ) : (
          <Globe className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      {tab.residency === 'suspended' ? <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] leading-3">挂起</Badge> : null}
      {tab.residency === 'restoring' ? <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] leading-3">恢复中</Badge> : null}
      <button
        type="button"
        aria-label={`关闭 ${label}`}
        className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
        onClick={guardClick(() => panel.closeTab(tab.tabId))}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
