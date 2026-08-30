import { FileDiff, FolderOpen, GitBranch, Globe, SquareTerminal } from 'lucide-react'
import type { ComponentType } from 'react'
import type { RightPanelFunction } from './right-panel-state'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'

import { Button } from '@/components/ui/button'
interface RightPanelLauncherProps {
  onOpen: (type: RightPanelFunction) => void
  review?: {
    recency: 'current' | 'previous'
    fileCount: number
  }
  onOpenReview?: () => void
}

const LAUNCHER_ITEMS: Array<{
  type: RightPanelFunction
  label: string
  shortcut?: string
  Icon: ComponentType<{ size?: number | string; className?: string }>
}> = [
  { type: 'files', label: '文件', shortcut: '⌘P', Icon: FolderOpen },
  { type: 'vault', label: 'Obsidian Vault', Icon: ObsidianIcon },
  { type: 'terminal', label: '终端', Icon: SquareTerminal },
  { type: 'browser', label: '浏览器', Icon: Globe },
  { type: 'git', label: 'Git', Icon: GitBranch },
]

export function RightPanelLauncher({ onOpen, review, onOpenReview }: RightPanelLauncherProps) {
  return (
    <div className="flex min-h-0 flex-1 items-end px-7 pb-14">
      <div className="flex w-full flex-col gap-2">
        {review && onOpenReview && (
          <Button
            variant="ghost"
            type="button"
            onClick={onOpenReview}
            title={`审阅${review.recency === 'current' ? '本轮' : '上一轮'}的 ${review.fileCount} 个变更文件`}
            className="flex h-11 w-full items-center gap-3 rounded-[8px] border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_68%,transparent)] px-3 text-left text-[15px] font-medium text-[var(--lume-text-primary)] transition-colors duration-150 ease-out hover:border-[var(--lume-border-strong)] hover:bg-[var(--lume-bg-elevated)]"
          >
            <FileDiff size={17} className="shrink-0 text-foreground/58" />
            <span className="min-w-0 flex-1 truncate">审阅</span>
            <span className="rounded-full bg-[var(--lume-accent-soft)] px-2 py-0.5 text-[12px] font-medium text-[var(--lume-text-secondary)]">
              {review.recency === 'current' ? '本轮' : '上一轮'}
            </span>
          </Button>
        )}
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
