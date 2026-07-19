import { ClipboardCheck, FolderOpen, Globe, Terminal, type LucideIcon } from 'lucide-react'
import type { RightPanelFunction } from './right-panel-state'

import { Button } from '@/components/ui/button'
interface RightPanelLauncherProps {
  onOpen: (type: RightPanelFunction) => void
  expanded?: boolean
}

const LAUNCHER_ITEMS: Array<{
  type: RightPanelFunction
  label: string
  shortcut?: string
  Icon: LucideIcon
}> = [
  { type: 'review', label: '审查', shortcut: '^⇧G', Icon: ClipboardCheck },
  { type: 'terminal', label: '终端', Icon: Terminal },
  { type: 'browser', label: '浏览器', shortcut: '⌘T', Icon: Globe },
  { type: 'files', label: '文件', shortcut: '⌘P', Icon: FolderOpen },
]

export function RightPanelLauncher({ onOpen, expanded = false }: RightPanelLauncherProps) {
  return (
    <div className={expanded ? 'flex min-h-0 flex-1 items-end' : 'flex min-h-0 flex-1 items-end px-7 pb-14'}>
      <div className="flex w-full flex-col gap-2">
        {LAUNCHER_ITEMS.map(({ type, label, shortcut, Icon }) => (
          <Button
                variant="ghost"
            key={type}
            type="button"
            onClick={() => onOpen(type)}
            className="flex h-11 w-full items-center gap-3 rounded-[8px] border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_68%,transparent)] px-3 text-left text-[15px] font-medium text-[var(--lume-text-primary)] transition-colors duration-150 ease-out hover:border-[var(--lume-border-strong)] hover:bg-[var(--lume-bg-elevated)]"
          >
            <Icon size={17} className="shrink-0 text-foreground/58" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {shortcut && (
              <span className="rounded-full bg-[var(--lume-accent-soft)] px-2 py-0.5 text-[12px] font-medium text-[var(--lume-text-secondary)]">
                {shortcut}
              </span>
            )}
          </Button>
        ))}
      </div>
    </div>
  )
}
