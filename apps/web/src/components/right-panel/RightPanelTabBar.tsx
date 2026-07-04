import { ClipboardCheck, FolderOpen, Globe, Plus, Terminal, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  RIGHT_PANEL_FUNCTION_ORDER,
  getAvailableRightPanelFunctions,
  type RightPanelFunction,
  type ThreadRightPanelWorkspace,
} from './right-panel-state'

import { Button } from '@/components/ui/button'
interface RightPanelTabBarProps {
  workspace: ThreadRightPanelWorkspace
  onActivate: (type: RightPanelFunction) => void
  onClose: (type: RightPanelFunction) => void
  onOpen: (type: RightPanelFunction) => void
}

const FUNCTION_META: Record<RightPanelFunction, {
  label: string
  Icon: LucideIcon
  shortcut?: string
}> = {
  review: { label: '审查', Icon: ClipboardCheck, shortcut: '^⇧G' },
  terminal: { label: '终端', Icon: Terminal },
  browser: { label: '浏览器', Icon: Globe, shortcut: '⌘T' },
  files: { label: '文件', Icon: FolderOpen, shortcut: '⌘P' },
}

export function RightPanelTabBar({
  workspace,
  onActivate,
  onClose,
  onOpen,
}: RightPanelTabBarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const availableFunctions = getAvailableRightPanelFunctions(workspace)
  const openedFunctions = RIGHT_PANEL_FUNCTION_ORDER.filter((type) => workspace.tabs[type])

  const openFunction = (type: RightPanelFunction) => {
    onOpen(type)
    setMenuOpen(false)
  }

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!shouldCloseRightPanelFunctionMenuForTarget(menuRef.current, event.target as Node)) return
      setMenuOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpen])

  return (
    <div className="relative flex h-11 shrink-0 items-center gap-1 border-b border-[var(--lume-border-subtle)] px-3">
      <div className="flex min-w-0 items-center gap-1">
        {openedFunctions.map((type) => {
          const { label, Icon } = FUNCTION_META[type]
          const active = workspace.activeTab === type

          return (
            <div
              key={type}
              className={cn(
                'group flex h-8 min-w-0 items-center rounded-[8px] border border-transparent text-[13px] font-medium transition-colors',
                active
                  ? 'border-[color:color-mix(in_oklab,var(--brand)_28%,var(--border))] bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                  : 'text-[var(--lume-text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--lume-text-secondary)]',
              )}
            >
              <Button
                variant="ghost"
                type="button"
                onClick={() => onActivate(type)}
                className="flex h-full min-w-0 items-center gap-2 rounded-l-[8px] pl-2.5 pr-1"
                title={label}
              >
                <Icon size={15} className="shrink-0" />
                <span className="min-w-0 max-w-[128px] truncate">{label}</span>
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => onClose(type)}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-foreground/42 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
                title={`关闭${label}`}
              >
                <X size={12} />
              </Button>
            </div>
          )
        })}

        <div className="relative shrink-0" ref={menuRef}>
          <Button
                variant="ghost"
            type="button"
            disabled={availableFunctions.length === 0}
            onClick={() => setMenuOpen((open) => !open)}
            className={cn(
              'flex size-8 items-center justify-center rounded-[8px] border border-transparent text-foreground/55 transition-colors',
              availableFunctions.length === 0
                ? 'cursor-not-allowed opacity-40'
                : 'hover:border-[var(--border)] hover:bg-[var(--surface-2)] hover:text-foreground',
            )}
            title={availableFunctions.length === 0 ? '全部功能已打开' : '打开功能'}
          >
            <Plus size={17} />
          </Button>

          {menuOpen && availableFunctions.length > 0 && (
            <div className="absolute left-0 top-10 z-20 min-w-[240px] rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-2 shadow-[0_18px_55px_-32px_hsl(var(--lume-shadow-panel)/0.62)] backdrop-blur">
              {availableFunctions.map((type) => {
                const { label, Icon, shortcut } = FUNCTION_META[type]
                return (
                  <Button
                variant="ghost"
                    key={type}
                    type="button"
                    onClick={() => openFunction(type)}
                    className="flex h-9 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px] font-medium text-[var(--lume-text-primary)] transition-colors hover:bg-[var(--lume-accent-soft)]"
                  >
                    <Icon size={16} className="shrink-0 text-foreground/58" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {shortcut && <span className="text-[12px] text-foreground/42">{shortcut}</span>}
                  </Button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function shouldCloseRightPanelFunctionMenuForTarget(
  menu: Pick<Node, 'contains'> | null,
  target: Node,
): boolean {
  return !menu?.contains(target)
}
