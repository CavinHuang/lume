import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { LumeComposerTone } from './lume-composer-state'

interface LumeComposerProps {
  tone: LumeComposerTone
  className?: string
  shellStyle?: CSSProperties
  editorClassName?: string
  footerClassName?: string
  topContent?: ReactNode
  editorSlot: ReactNode
  supportingContent?: ReactNode
  leadingTools?: ReactNode
  trailingTools?: ReactNode
  actionSlot: ReactNode
}

const baseShell = {
  borderColor: 'var(--lume-border-subtle)',
  background:
    'linear-gradient(180deg, color-mix(in oklab, var(--lume-bg-elevated) 96%, transparent), color-mix(in oklab, var(--lume-bg-panel) 90%, var(--lume-bg-elevated)))',
  boxShadow: 'none',
}

const toneStyles: Record<
  LumeComposerTone,
  {
    shell: {
      borderColor: string
      background: string
      boxShadow: string
    }
    dividerColor: string
  }
> = {
  idle: {
    shell: baseShell,
    dividerColor: 'var(--lume-border-subtle)',
  },
  ready: {
    shell: {
      ...baseShell,
      borderColor:
        'color-mix(in oklab, var(--lume-accent) 32%, var(--lume-border-strong))',
    },
    dividerColor: 'var(--lume-border-subtle)',
  },
  streaming: {
    shell: {
      ...baseShell,
      borderColor:
        'color-mix(in oklab, var(--lume-accent) 24%, var(--lume-border-strong))',
    },
    dividerColor: 'var(--lume-border-subtle)',
  },
}

export function getLumeComposerPrimaryActionClassName({
  enabled,
}: {
  enabled: boolean
}) {
  return cn(
    'inline-flex h-8 min-w-[76px] items-center justify-center gap-2 rounded-full px-3 text-[12px] font-medium transition-colors duration-150 ease-out',
    enabled
      ? 'bg-[var(--lume-accent)] text-[var(--lume-accent-foreground)] hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_88%,var(--lume-accent-2))]'
      : 'cursor-not-allowed bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_70%,transparent)] text-[var(--lume-text-muted)]',
  )
}

export function LumeComposer({
  tone,
  className,
  shellStyle,
  editorClassName,
  footerClassName,
  topContent,
  editorSlot,
  supportingContent,
  leadingTools,
  trailingTools,
  actionSlot,
}: LumeComposerProps) {
  const palette = toneStyles[tone]
  const hasToolbarContent = Boolean(leadingTools) || Boolean(trailingTools)

  return (
    <div
      data-tone={tone}
      className={cn(
        'lume-composer relative overflow-visible rounded-[1.45rem] border backdrop-blur transition-[border-color,box-shadow,transform,background-color] duration-200 ease-out focus-within:border-[color:color-mix(in_oklab,var(--lume-accent)_42%,var(--lume-border-strong))] focus-within:shadow-[0_12px_36px_-28px_hsl(var(--lume-shadow-panel)/0.7)] motion-reduce:transition-none',
        className,
      )}
      style={{ ...palette.shell, ...shellStyle }}
    >
      <div className="relative">
        {topContent}

        <div className={cn('max-h-[240px] min-h-[64px] overflow-y-auto px-4 pb-2 pt-3', editorClassName)}>{editorSlot}</div>

        {supportingContent}

        <div
          className={cn(
            'lume-composer-footer relative flex flex-wrap items-center gap-2.5 border-t',
            'px-3 py-1.5',
            footerClassName,
          )}
          style={{ borderColor: palette.dividerColor }}
        >
          {hasToolbarContent ? (
            <div className="lume-composer-leading-tools flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{leadingTools}</div>
          ) : null}
          <div
            data-composer-right-tools="true"
            className={cn(
              'flex shrink-0 items-center gap-1.5',
              hasToolbarContent && 'ml-auto',
            )}
          >
            {trailingTools}
            {actionSlot}
          </div>
        </div>
      </div>
    </div>
  )
}
