import { ClipboardCheck, FolderOpen, Globe, Terminal, type LucideIcon } from 'lucide-react'
import type { RightPanelFunction } from './right-panel-state'

interface RightPanelLauncherProps {
  onOpen: (type: RightPanelFunction) => void
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

export function RightPanelLauncher({ onOpen }: RightPanelLauncherProps) {
  return (
    <div className="flex min-h-0 flex-1 items-end px-7 pb-14">
      <div className="flex w-full flex-col gap-2">
        {LAUNCHER_ITEMS.map(({ type, label, shortcut, Icon }) => (
          <button
            key={type}
            type="button"
            onClick={() => onOpen(type)}
            className="flex h-11 w-full items-center gap-3 rounded-[8px] bg-foreground/[0.04] px-3 text-left text-[15px] font-medium text-foreground transition-colors hover:bg-foreground/[0.08]"
          >
            <Icon size={17} className="shrink-0 text-foreground/58" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {shortcut && (
              <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[12px] font-medium text-foreground/50">
                {shortcut}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
