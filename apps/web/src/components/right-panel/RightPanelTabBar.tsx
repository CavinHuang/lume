import { Braces, Camera, CircleAlert, FileDiff, FolderOpen, Globe, List, LoaderCircle, MessageSquare, Mic, Package, Plus, Volume2, X, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { cn } from '@/lib/utils'
import {
  disambiguateFileTabLabels,
  rightPanelFileTargetName,
  type RightPanelActiveItem,
  type RightPanelFileTab,
} from './right-panel-files-state'
import type { RightPanelBrowserTab } from './right-panel-browser-state'
import {
  RIGHT_PANEL_FUNCTION_ORDER,
  getAvailableRightPanelFunctions,
  type RightPanelFunction,
  type ThreadRightPanelWorkspace,
} from './right-panel-state'

export type RightPanelTabItem =
  | { kind: 'review'; id: string; label: string }
  | { kind: 'function'; id: string; type: RightPanelFunction; label: string }
  | { kind: 'browser'; id: string; tab: RightPanelBrowserTab; label: string }
  | { kind: 'file'; id: string; tab: RightPanelFileTab; label: string }

const FUNCTION_META: Record<RightPanelFunction, { label: string; Icon: LucideIcon; shortcut?: string }> = {
  browser: { label: '浏览器', Icon: Globe, shortcut: '⌘T' },
  files: { label: '文件', Icon: FolderOpen, shortcut: '⌘P' },
  // chat 仅作类型完备；side-chat 不在 tab 栏主动添加，由划线引用「打开右侧问答」触发（见 #18）
  chat: { label: '问答', Icon: MessageSquare },
}

export function buildRightPanelTabItems(
  workspace: ThreadRightPanelWorkspace,
  fileTabs: RightPanelFileTab[],
  reviewOpen = false,
  browserTabs: RightPanelBrowserTab[] = [],
): RightPanelTabItem[] {
  const labels = disambiguateFileTabLabels(fileTabs)
  const result: RightPanelTabItem[] = []
  if (reviewOpen) result.push({ kind: 'review', id: 'review', label: '审阅' })
  result.push(...browserTabs.map((tab) => ({ kind: 'browser' as const, id: tab.id, tab, label: tab.title || '新标签页' })))
  for (const type of RIGHT_PANEL_FUNCTION_ORDER) {
    if (type === 'browser') continue
    if (!workspace.tabs[type]) continue
    result.push({ kind: 'function', id: `function:${type}`, type, label: FUNCTION_META[type].label })
    if (type === 'files') {
      result.push(...fileTabs.map((tab) => ({ kind: 'file' as const, id: tab.id, tab, label: labels[tab.id]! })))
    }
  }
  if (!workspace.tabs.files) {
    result.push(...fileTabs.map((tab) => ({ kind: 'file' as const, id: tab.id, tab, label: labels[tab.id]! })))
  }
  return result
}

interface RightPanelTabBarProps {
  workspace: ThreadRightPanelWorkspace
  fileTabs: RightPanelFileTab[]
  browserTabs?: RightPanelBrowserTab[]
  activeItem: RightPanelActiveItem | null
  reviewOpen?: boolean
  reviewActive?: boolean
  onActivateFunction: (type: RightPanelFunction) => void
  onActivateFile: (tabId: string) => void
  onActivateBrowser?: (tabId: string) => void
  onCloseFunction: (type: RightPanelFunction) => void
  onCloseFile: (tabId: string) => void
  onCloseBrowser?: (tabId: string) => void
  onNewBrowserToRight?: (tabId: string) => void
  onReloadBrowser?: (tabId: string) => void
  onDuplicateBrowser?: (tabId: string) => void
  onCloseOtherBrowsers?: (tabId: string) => void
  onCloseBrowsersToRight?: (tabId: string) => void
  onMoveBrowserToMain?: (tabId: string) => void
  onMoveBrowserToThread?: (tabId: string, threadId: string) => void
  onBrowserMenuOpenChange?: (tabId: string, open: boolean) => void
  browserThreadTargets?: Array<{ id: string; label: string }>
  canRestoreBrowser?: boolean
  onRestoreBrowser?: () => void
  onActivateReview?: () => void
  onCloseReview?: () => void
  onOpenFunction: (type: RightPanelFunction) => void
}

export function RightPanelTabBar(props: RightPanelTabBarProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)
  const items = useMemo(
    () => buildRightPanelTabItems(props.workspace, props.fileTabs, props.reviewOpen, props.browserTabs),
    [props.workspace, props.fileTabs, props.reviewOpen, props.browserTabs],
  )
  const availableFunctions = [
    'browser' as const,
    ...getAvailableRightPanelFunctions(props.workspace).filter((type) => type !== 'browser'),
  ]

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.activeItem])

  const isActive = (item: RightPanelTabItem) => item.kind === 'review'
    ? props.reviewActive === true
    : item.kind === 'function'
      ? !props.reviewActive && props.activeItem?.kind === 'function' && props.activeItem.type === item.type
      : item.kind === 'browser'
        ? !props.reviewActive && props.activeItem?.kind === 'browser' && props.activeItem.tabId === item.id
      : !props.reviewActive && props.activeItem?.kind === 'file' && props.activeItem.tabId === item.id

  const activate = (item: RightPanelTabItem) => item.kind === 'review'
    ? props.onActivateReview?.()
    : item.kind === 'function'
      ? props.onActivateFunction(item.type)
      : item.kind === 'browser'
        ? props.onActivateBrowser?.(item.id)
      : props.onActivateFile(item.id)

  const close = (item: RightPanelTabItem) => {
    const fallback = isActive(item) ? getRightPanelCloseFallback(items, item.id) : undefined
    if (item.kind === 'review') props.onCloseReview?.()
    else if (item.kind === 'function') props.onCloseFunction(item.type)
    else if (item.kind === 'browser') props.onCloseBrowser?.(item.id)
    else props.onCloseFile(item.id)
    if (fallback) activate(fallback)
  }

  return (
    <div className="flex h-10 shrink-0 select-none items-center gap-1 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-2">
      <div
        ref={scrollerRef}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onWheel={(event) => {
          if (!scrollerRef.current || event.deltaY === 0) return
          scrollerRef.current.scrollLeft += event.deltaY
        }}
      >
        {items.map((item) => {
          const active = isActive(item)
          const Icon = item.kind === 'review' ? FileDiff : item.kind === 'function' ? FUNCTION_META[item.type].Icon : item.kind === 'browser' ? Globe : null
          const title = item.kind === 'file'
            ? item.tab.target.kind === 'mcp-resource'
              ? `${item.tab.target.resource.serverName}: ${item.tab.target.resource.uri}`
              : `${item.tab.target.kind}: ${item.tab.target.ref.source}:${item.tab.target.ref.relativePath}`
            : item.kind === 'browser'
              ? `${item.tab.url || item.label}${item.tab.lifecycle === 'crashed' ? ' · 页面已崩溃' : item.tab.lifecycle === 'suspended' ? ' · 后台已挂起' : ''}`
              : item.label
          const tabNode = (
            <div
              key={item.id}
              ref={active ? activeRef : undefined}
              onMouseDown={(event) => {
                if (!shouldCloseTabForMouseButton(event.button)) return
                event.preventDefault()
                close(item)
              }}
              className={cn(
                'group relative flex h-7 min-w-[90px] max-w-[160px] shrink-0 items-center overflow-hidden rounded-lg bg-[var(--lume-bg-panel)] text-sm transition-colors',
                active
                  ? 'bg-[color-mix(in_srgb,var(--lume-text-primary)_5%,var(--lume-bg-panel))] text-[var(--lume-text-primary)]'
                  : 'text-[var(--lume-text-muted)] hover:bg-[color-mix(in_srgb,var(--lume-text-primary)_5%,var(--lume-bg-panel))] hover:text-[var(--lume-text-secondary)]',
              )}
              title={title}
            >
              <Button
                variant="ghost"
                type="button"
                onClick={() => activate(item)}
                className={cn(
                  'h-full min-w-0 flex-1 justify-start gap-2 rounded-lg px-2 font-normal hover:bg-transparent',
                  'group-hover:pr-7 group-focus-within:pr-7',
                  active && 'pr-7',
                )}
              >
                {item.kind === 'browser' && item.tab.isLoading
                  ? <LoaderCircle size={14} className="animate-spin" />
                  : item.kind === 'browser' && item.tab.lifecycle === 'crashed'
                    ? <CircleAlert size={14} className="text-destructive" />
                  : item.kind === 'browser' && item.tab.faviconUrl
                  ? <img src={item.tab.faviconUrl} alt="" className="size-3.5 rounded-sm" />
                  : Icon
                  ? <Icon size={14} />
                  : item.kind === 'file'
                    ? item.tab.target.kind === 'mcp-resource'
                      ? <Braces size={14} />
                      : item.tab.target.kind === 'artifact'
                        ? <Package size={14} />
                        : <FileTypeIcon filename={rightPanelFileTargetName(item.tab.target)} size={14} />
                    : null}
                <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                {item.kind === 'browser' && item.tab.mediaState?.camera && <Camera size={11} className="text-red-500" aria-label="摄像头使用中" />}
                {item.kind === 'browser' && item.tab.mediaState?.microphone && <Mic size={11} className="text-red-500" aria-label="麦克风使用中" />}
                {item.kind === 'browser' && item.tab.mediaState?.audible && <Volume2 size={11} className="text-muted-foreground" aria-label="正在播放声音" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                onClick={() => close(item)}
                // Button 默认带 active:not-aria-[haspopup]:translate-y-px，按下时覆盖此处的 -translate-y-1/2 居中，
                // 导致关闭按钮下跳约 13px、鼠标脱离而 click 不触发（关不掉最后一个 tab）。用 !important 强制按压时保持居中。
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
          if (item.kind !== 'browser') return tabNode
          const browserIndex = props.browserTabs?.findIndex((tab) => tab.id === item.id) ?? -1
          const hasOtherBrowsers = (props.browserTabs?.length ?? 0) > 1
          const hasBrowsersToRight = browserIndex >= 0 && browserIndex < (props.browserTabs?.length ?? 0) - 1
          return (
            <ContextMenu key={item.id} onOpenChange={(open) => props.onBrowserMenuOpenChange?.(item.id, open)}>
              <ContextMenuTrigger render={tabNode} />
              <ContextMenuContent className="min-w-52">
                <ContextMenuItem onSelect={() => props.onNewBrowserToRight?.(item.id)}>在右侧新建标签页</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => props.onReloadBrowser?.(item.id)}>重新加载</ContextMenuItem>
                <ContextMenuItem onSelect={() => props.onDuplicateBrowser?.(item.id)}>复制标签页</ContextMenuItem>
                <ContextMenuItem onSelect={() => props.onMoveBrowserToMain?.(item.id)}>移到主区域</ContextMenuItem>
                {props.browserThreadTargets?.length ? (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>移动到其他任务</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {props.browserThreadTargets.map((thread) => <ContextMenuItem key={thread.id} onSelect={() => props.onMoveBrowserToThread?.(item.id, thread.id)}>{thread.label}</ContextMenuItem>)}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ) : null}
                <ContextMenuSeparator />
                <ContextMenuItem disabled={!hasOtherBrowsers} onSelect={() => props.onCloseOtherBrowsers?.(item.id)}>关闭其他标签页</ContextMenuItem>
                <ContextMenuItem disabled={!hasBrowsersToRight} onSelect={() => props.onCloseBrowsersToRight?.(item.id)}>关闭右侧标签页</ContextMenuItem>
                <ContextMenuItem destructive onSelect={() => close(item)}>关闭</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
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
          {items.map((item, index) => (
            <DropdownMenuItem key={item.id} onSelect={() => activate(item)}>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <Button variant="ghost" className="size-5 p-0" onClick={(event) => closeAllTabsMenuItem(event, () => close(item))}><X size={11} /></Button>
              {index === items.length - 1 ? null : undefined}
            </DropdownMenuItem>
          ))}
          {items.length > 0 && <DropdownMenuSeparator />}
          {props.canRestoreBrowser && <DropdownMenuItem onSelect={props.onRestoreBrowser}>恢复最近关闭的浏览器标签</DropdownMenuItem>}
          {items.length === 0 && <DropdownMenuItem disabled>暂无 Tab</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
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
