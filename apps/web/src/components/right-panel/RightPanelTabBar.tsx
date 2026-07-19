import { FolderOpen, Globe, List, Plus, X, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
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
  type RightPanelActiveItem,
  type RightPanelFileTab,
} from './right-panel-files-state'
import {
  RIGHT_PANEL_FUNCTION_ORDER,
  getAvailableRightPanelFunctions,
  type RightPanelFunction,
  type ThreadRightPanelWorkspace,
} from './right-panel-state'

export type RightPanelTabItem =
  | { kind: 'function'; id: string; type: RightPanelFunction; label: string }
  | { kind: 'file'; id: string; tab: RightPanelFileTab; label: string }

const FUNCTION_META: Record<RightPanelFunction, { label: string; Icon: LucideIcon; shortcut?: string }> = {
  browser: { label: '浏览器', Icon: Globe, shortcut: '⌘T' },
  files: { label: '文件', Icon: FolderOpen, shortcut: '⌘P' },
}

export function buildRightPanelTabItems(
  workspace: ThreadRightPanelWorkspace,
  fileTabs: RightPanelFileTab[],
): RightPanelTabItem[] {
  const labels = disambiguateFileTabLabels(fileTabs)
  const result: RightPanelTabItem[] = []
  for (const type of RIGHT_PANEL_FUNCTION_ORDER) {
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
  activeItem: RightPanelActiveItem | null
  onActivateFunction: (type: RightPanelFunction) => void
  onActivateFile: (tabId: string) => void
  onCloseFunction: (type: RightPanelFunction) => void
  onCloseFile: (tabId: string) => void
  onOpenFunction: (type: RightPanelFunction) => void
}

export function RightPanelTabBar(props: RightPanelTabBarProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)
  const items = useMemo(
    () => buildRightPanelTabItems(props.workspace, props.fileTabs),
    [props.workspace, props.fileTabs],
  )
  const availableFunctions = getAvailableRightPanelFunctions(props.workspace)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.activeItem])

  const isActive = (item: RightPanelTabItem) => item.kind === 'function'
    ? props.activeItem?.kind === 'function' && props.activeItem.type === item.type
    : props.activeItem?.kind === 'file' && props.activeItem.tabId === item.id

  const activate = (item: RightPanelTabItem) => item.kind === 'function'
    ? props.onActivateFunction(item.type)
    : props.onActivateFile(item.id)

  const close = (item: RightPanelTabItem) => item.kind === 'function'
    ? props.onCloseFunction(item.type)
    : props.onCloseFile(item.id)

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--lume-border-subtle)] px-1.5">
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
          const Icon = item.kind === 'function' ? FUNCTION_META[item.type].Icon : null
          const title = item.kind === 'file'
            ? `${item.tab.ref.source}: ${item.tab.ref.relativePath}`
            : item.label
          return (
            <div
              key={item.id}
              ref={active ? activeRef : undefined}
              onMouseDown={(event) => {
                if (!shouldCloseTabForMouseButton(event.button)) return
                event.preventDefault()
                close(item)
              }}
              className={cn(
                'group flex h-7 shrink-0 items-center rounded-md border border-transparent text-[12px] transition-colors',
                active
                  ? 'border-[color:color-mix(in_oklab,var(--brand)_24%,var(--border))] bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--surface-1))] text-[var(--brand)]'
                  : 'text-[var(--lume-text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--lume-text-secondary)]',
              )}
              title={title}
            >
              <Button variant="ghost" type="button" onClick={() => activate(item)} className="h-full gap-1.5 rounded-md px-2">
                {Icon ? <Icon size={14} /> : item.kind === 'file' ? <FileTypeIcon filename={item.tab.ref.relativePath} size={14} /> : null}
                <span className="max-w-[132px] truncate">{item.label}</span>
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => close(item)}
                className={cn('mr-0.5 size-5 p-0 opacity-0 group-hover:opacity-100', active && 'opacity-100')}
                title={`关闭${item.label}`}
              >
                <X size={11} />
              </Button>
            </div>
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

export function closeAllTabsMenuItem(
  event: Pick<Event, 'preventDefault' | 'stopPropagation'>,
  close: () => void,
): void {
  event.preventDefault()
  event.stopPropagation()
  close()
}
