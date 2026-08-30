/**
 * 右侧面板统一标签条 —— ZCode yAt 标签条语义的 Lume 落法。
 *
 * 一条标签条承载全部 tab 类型(browser/git/files/vault/chat + 文件子 tab + 审阅):
 *  - 激活/关闭(close)由统一 tab 仓库的 reducer 语义承担(邻居回落);
 *  - 关其他/关全部(ZCode 右键菜单 Ede/Dde)挂在功能 tab 右键 ContextMenu;
 *  - dnd-kit 拖拽重排(activation distance 4 + horizontal 策略,Ade:不动选中),
 *    仅功能 tab 可拖,文件子 tab/审阅跟随 files 宿主;
 *  - 「全部 Tab」总览 = 打开列表 + 最近关闭环(8 条,相对时间,重开);
 *  - 溢出:横向滚动 + 滚轮续接,「+」与总览入口常驻右侧独立区。
 *
 * UI 约定:一律使用 components/ui 的 shadcn 原子组件(AGENTS.md);文案为内联中文。
 */
import { Braces, FileDiff, FolderOpen, GitBranch, Globe, List, MessageSquare, Package, Plus, SquareTerminal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, type ComponentType, type CSSProperties, type RefCallback } from 'react'
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
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { cn } from '@/lib/utils'
import { formatRelativeTime, reorderedByIds } from '@/components/browser/browser-panel-logic'
import {
  disambiguateFileTabLabels,
  rightPanelFileTargetName,
  type RightPanelActiveItem,
  type RightPanelFileTab,
} from './right-panel-files-state'
import {
  getAvailableRightPanelFunctions,
  type RightPanelClosedEntry,
  type RightPanelFunction,
  type RightPanelTab,
} from './right-panel-state'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'

export type RightPanelTabItem =
  | { kind: 'review'; id: string; label: string }
  | { kind: 'function'; id: string; type: RightPanelFunction; label: string }
  | { kind: 'file'; id: string; tab: RightPanelFileTab; label: string }

/** Lucide 图标与品牌 SVG 组件的公共渲染契约（size/className）。 */
type PanelIcon = ComponentType<{ size?: number | string; className?: string }>

const FUNCTION_META: Record<RightPanelFunction, { label: string; Icon: PanelIcon; shortcut?: string }> = {
  files: { label: '文件', Icon: FolderOpen, shortcut: '⌘P' },
  // chat 仅作类型完备；side-chat 由划线引用「打开右侧问答」触发（见 #18）
  chat: { label: '问答', Icon: MessageSquare },
  vault: { label: 'Obsidian', Icon: ObsidianIcon },
  terminal: { label: '终端', Icon: SquareTerminal },
  browser: { label: '浏览器', Icon: Globe },
  git: { label: 'Git', Icon: GitBranch },
}

/** 统一 tab 排列序 → 标签条条目(审阅置顶;文件子 tab 跟随 files 宿主,files 关闭时殿后)。 */
export function buildRightPanelTabItems(
  tabs: readonly RightPanelTab[],
  fileTabs: RightPanelFileTab[],
  reviewOpen = false,
): RightPanelTabItem[] {
  const labels = disambiguateFileTabLabels(fileTabs)
  const fileItems = fileTabs.map((tab) => ({ kind: 'file' as const, id: tab.id, tab, label: labels[tab.id]! }))
  const result: RightPanelTabItem[] = []
  if (reviewOpen) result.push({ kind: 'review', id: 'review', label: '审阅' })
  let filesEmitted = false
  for (const tab of tabs) {
    result.push({ kind: 'function', id: tab.id, type: tab.type, label: FUNCTION_META[tab.type].label })
    if (tab.type === 'files') {
      result.push(...fileItems)
      filesEmitted = true
    }
  }
  if (!filesEmitted) result.push(...fileItems)
  return result
}

interface RightPanelTabBarProps {
  /** 统一 tab(用户排列序)。 */
  tabs: RightPanelTab[]
  fileTabs: RightPanelFileTab[]
  activeTabId: string | null
  activeItem: RightPanelActiveItem | null
  closedTabs: RightPanelClosedEntry[]
  reviewOpen?: boolean
  reviewActive?: boolean
  onActivateTab: (tabId: string) => void
  onActivateFile: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onCloseFile: (tabId: string) => void
  onCloseOtherTabs: (tabId: string) => void
  onCloseAllTabs: () => void
  onReorderTabs: (orderedIds: string[]) => void
  onReopenClosedTab: (entryId: string) => void
  onOpenFunction: (type: RightPanelFunction) => void
  onActivateReview?: () => void
  onCloseReview?: () => void
}

export function RightPanelTabBar(props: RightPanelTabBarProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)
  const items = useMemo(
    () => buildRightPanelTabItems(props.tabs, props.fileTabs, props.reviewOpen),
    [props.tabs, props.fileTabs, props.reviewOpen],
  )
  const availableFunctions = getAvailableRightPanelFunctions(props.tabs)
  const functionTabIds = useMemo(() => props.tabs.map((tab) => tab.id), [props.tabs])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.activeTabId, props.activeItem])

  const isActive = (item: RightPanelTabItem) => item.kind === 'review'
    ? props.reviewActive === true
    : item.kind === 'function'
      // 文件 tab 激活时功能 tab 让位(高亮互斥,激活唯一)
      ? !props.reviewActive && props.activeItem?.kind !== 'file' && props.activeTabId === item.id
      : !props.reviewActive && props.activeItem?.kind === 'file' && props.activeItem.tabId === item.id

  const activate = (item: RightPanelTabItem) => item.kind === 'review'
    ? props.onActivateReview?.()
    : item.kind === 'function'
      ? props.onActivateTab(item.id)
      : props.onActivateFile(item.id)

  const close = (item: RightPanelTabItem) => {
    // 功能/文件 tab 的邻位回落由各自 reducer 承担;审阅非统一 tab,本地找邻居。
    const fallback = item.kind === 'review' && isActive(item)
      ? getRightPanelCloseFallback(items, item.id)
      : undefined
    if (item.kind === 'review') props.onCloseReview?.()
    else if (item.kind === 'function') props.onCloseTab(item.id)
    else props.onCloseFile(item.id)
    if (fallback) activate(fallback)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = functionTabIds.indexOf(String(active.id))
    const newIndex = functionTabIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const orderedIds = reorderedByIds(functionTabIds, arrayMove([...functionTabIds], oldIndex, newIndex))
    if (orderedIds) props.onReorderTabs(orderedIds)
  }

  const activeFunctionTab = props.tabs.find((tab) => tab.id === props.activeTabId)
  const canCloseOthers = props.tabs.length > 1

  const renderTabItem = (item: RightPanelTabItem) => {
    const active = isActive(item)
    const Icon = item.kind === 'function'
      ? FUNCTION_META[item.type].Icon
      : item.kind === 'review' ? FileDiff : null
    const title = item.kind === 'file'
      ? item.tab.target.kind === 'mcp-resource'
        ? `${item.tab.target.resource.serverName}: ${item.tab.target.resource.uri}`
        : `${item.tab.target.kind}: ${item.tab.target.ref.source}:${item.tab.target.ref.relativePath}`
      : item.label
    const chipProps = {
      item,
      Icon,
      title,
      active,
      activeRef: active ? (node: HTMLDivElement | null) => { activeRef.current = node } : undefined,
      onActivate: () => activate(item),
      onClose: () => close(item),
    }
    if (item.kind !== 'function') {
      return <RightPanelTabChip key={item.id} {...chipProps} />
    }
    return (
      <FunctionTabChip
        key={item.id}
        item={item}
        Icon={FUNCTION_META[item.type].Icon}
        title={title}
        active={active}
        activeRef={chipProps.activeRef}
        onActivate={chipProps.onActivate}
        onClose={chipProps.onClose}
        canCloseOthers={canCloseOthers}
        onCloseOtherTabs={() => props.onCloseOtherTabs(item.id)}
        onCloseAllTabs={props.onCloseAllTabs}
      />
    )
  }

  return (
    <div className="flex h-10 shrink-0 select-none items-center gap-1 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-2">
      <div
        ref={scrollerRef}
        data-side-pane-tabs-viewport=""
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onWheel={(event) => {
          if (!scrollerRef.current || event.deltaY === 0) return
          scrollerRef.current.scrollLeft += event.deltaY
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={functionTabIds} strategy={horizontalListSortingStrategy}>
            <div data-side-pane-tabs-content="" className="flex min-w-0 items-center gap-0.5">
              {items.map(renderTabItem)}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" className="size-7 p-0" title="打开功能" />}>
          <Plus size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {availableFunctions.map((type) => {
            const { Icon, label, shortcut } = FUNCTION_META[type]
            return (
              <DropdownMenuItem key={type} onSelect={() => props.onOpenFunction(type)}>
                <Icon size={14} />
                <span className="flex-1">{label}</span>
                {shortcut && <span className="text-foreground/40">{shortcut}</span>}
              </DropdownMenuItem>
            )
          })}
          {availableFunctions.length === 0 && <DropdownMenuItem disabled>全部功能已打开</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" className="size-7 p-0" title="全部 Tab" />}>
          <List size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 min-w-56 overflow-y-auto">
          {items.map((item) => (
            <DropdownMenuItem key={item.id} onSelect={() => activate(item)}>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <Button variant="ghost" className="size-5 p-0" onClick={(event) => closeAllTabsMenuItem(event, () => close(item))}><X size={11} /></Button>
            </DropdownMenuItem>
          ))}
          {items.length === 0 && <DropdownMenuItem disabled>暂无 Tab</DropdownMenuItem>}
          {items.length > 0 && <DropdownMenuSeparator />}
          {props.closedTabs.length > 0 && (
            <>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">最近关闭</div>
              {props.closedTabs.map((entry) => {
                const MetaEntry = FUNCTION_META[entry.tab.type]
                return (
                <DropdownMenuItem key={entry.tab.id} onSelect={() => props.onReopenClosedTab(entry.tab.id)}>
                  <MetaEntry.Icon size={14} />
                  <span className="min-w-0 flex-1 truncate">{MetaEntry.label}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(entry.closedAt)}</span>
                </DropdownMenuItem>
                )
              })}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            disabled={!activeFunctionTab || !canCloseOthers}
            onSelect={() => activeFunctionTab && props.onCloseOtherTabs(activeFunctionTab.id)}
          >
            关闭其他 Tab
          </DropdownMenuItem>
          <DropdownMenuItem disabled={props.tabs.length === 0} onSelect={() => props.onCloseAllTabs()}>
            关闭全部 Tab
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** 拖拽绑定(仅功能 tab;类型取自 useSortable,展开方式与 BrowserTabStrip 一致)。 */
type TabDragBinding = Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners' | 'setNodeRef' | 'isDragging'> & {
  style: CSSProperties | undefined
}

/** 功能 tab:拖拽重排 + 右键 关闭/关其他/关全部(ZCode yAt 右键菜单)。 */
function FunctionTabChip({ item, Icon, title, active, activeRef, onActivate, onClose, canCloseOthers, onCloseOtherTabs, onCloseAllTabs }: {
  item: Extract<RightPanelTabItem, { kind: 'function' }>
  Icon: PanelIcon
  title: string
  active: boolean
  activeRef?: RefCallback<HTMLDivElement>
  onActivate: () => void
  onClose: () => void
  canCloseOthers: boolean
  onCloseOtherTabs: () => void
  onCloseAllTabs: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  const drag: TabDragBinding = {
    setNodeRef,
    attributes,
    listeners,
    style: { transform: CSS.Transform.toString(transform), transition },
    isDragging,
  }
  const chip = (
    <RightPanelTabChip
      item={item}
      Icon={Icon}
      title={title}
      active={active}
      activeRef={activeRef}
      onActivate={onActivate}
      onClose={onClose}
      drag={drag}
    />
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger render={chip} />
      <ContextMenuContent>
        <ContextMenuItem onSelect={onClose}>关闭</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOthers} onSelect={onCloseOtherTabs}>关闭其他</ContextMenuItem>
        <ContextMenuItem destructive onSelect={onCloseAllTabs}>关闭全部</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function RightPanelTabChip({ item, Icon, title, active, activeRef, onActivate, onClose, drag }: {
  item: RightPanelTabItem
  Icon: PanelIcon | null
  title: string
  active: boolean
  activeRef?: RefCallback<HTMLDivElement>
  onActivate: () => void
  onClose: () => void
  drag?: TabDragBinding
}) {
  // Button 默认带 active:not-aria-[haspopup]:translate-y-px，按下时覆盖关闭按钮的 -translate-y-1/2 居中，
  // 导致其下跳约 13px、鼠标脱离而 click 不触发（关不掉最后一个 tab）。用 !important 强制按压时保持居中。
  return (
    <div
      ref={(node) => {
        drag?.setNodeRef(node)
        activeRef?.(node)
      }}
      data-side-pane-tab-id={item.id}
      data-state={active ? 'active' : 'inactive'}
      onMouseDown={(event) => {
        if (!shouldCloseTabForMouseButton(event.button)) return
        event.preventDefault()
        onClose()
      }}
      style={drag?.style}
      className={cn(
        'group relative flex h-7 min-w-[90px] max-w-[160px] shrink-0 items-center overflow-hidden rounded-lg bg-[var(--lume-bg-panel)] text-sm transition-colors',
        drag && 'touch-none',
        drag?.isDragging && 'z-10 shadow-md',
        active
          ? 'bg-[color-mix(in_srgb,var(--lume-text-primary)_5%,var(--lume-bg-panel))] text-[var(--lume-text-primary)]'
          : 'text-[var(--lume-text-muted)] hover:bg-[color-mix(in_srgb,var(--lume-text-primary)_5%,var(--lume-bg-panel))] hover:text-[var(--lume-text-secondary)]',
      )}
      title={title}
      {...(drag ? { ...drag.attributes, ...drag.listeners } : {})}
    >
      <Button
        variant="ghost"
        type="button"
        onClick={onActivate}
        className={cn(
          'h-full min-w-0 flex-1 justify-start gap-2 rounded-lg px-2 font-normal hover:bg-transparent',
          'group-hover:pr-7 group-focus-within:pr-7',
          active && 'pr-7',
        )}
      >
        {Icon
          ? <Icon size={14} />
          : item.kind === 'file'
            ? item.tab.target.kind === 'mcp-resource'
              ? <Braces size={14} />
              : item.tab.target.kind === 'artifact'
                ? <Package size={14} />
                : <FileTypeIcon filename={rightPanelFileTargetName(item.tab.target)} size={14} />
            : null}
        <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        onClick={onClose}
        className={cn(
          'pointer-events-none absolute right-0.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 transition-opacity active:-translate-y-1/2! group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
          active && 'pointer-events-auto opacity-100',
        )}
        title={`关闭${item.label}`}
      >
        <X size={12} />
      </Button>
    </div>
  )
}

export function shouldCloseRightPanelFunctionMenuForTarget(
  menu: Pick<Node, 'contains'> | null,
  target: Node,
): boolean {
  return !menu?.contains(target)
}

export function shouldCloseTabForMouseButton(button: number): boolean {
  return button === 1
}

export function getRightPanelCloseFallback(
  items: RightPanelTabItem[],
  closingId: string,
): RightPanelTabItem | undefined {
  const index = items.findIndex((item) => item.id === closingId)
  if (index < 0) return undefined
  return items[index + 1] ?? items[index - 1]
}

export function closeAllTabsMenuItem(
  event: Pick<Event, 'preventDefault' | 'stopPropagation'>,
  close: () => void,
): void {
  event.preventDefault()
  event.stopPropagation()
  close()
}
