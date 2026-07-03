import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { LumeComposerTone } from './lume-composer-state'

type LumeComposerScale = 'compact' | 'hero'

interface LumeComposerProps {
  tone: LumeComposerTone
  scale?: LumeComposerScale
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

type LumeComposerActionSize = 'compact' | 'hero'

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

const scaleClasses: Record<
  LumeComposerScale,
  {
    shell: string
    editor: string
    footer: string
  }
> = {
  compact: {
    shell: 'rounded-[1.45rem]',
    editor: 'px-4 pt-3 pb-2',
    footer: 'px-3 py-1.5',
  },
  hero: {
    shell: 'rounded-[1rem]',
    editor: 'px-4 pt-4 pb-2',
    footer: 'px-3 py-1.5',
  },
}

const actionSizeClasses: Record<LumeComposerActionSize, string> = {
  compact: 'h-8 px-3 text-[11.5px]',
  hero: 'h-8 px-3 text-[12px]',
}

export function getLumeComposerPrimaryActionClassName({
  enabled,
  size = 'compact',
}: {
  enabled: boolean
  size?: LumeComposerActionSize
}) {
  return cn(
    'inline-flex items-center gap-2 rounded-full font-medium transition-colors duration-150 ease-out',
    actionSizeClasses[size],
    enabled
      ? 'bg-[var(--lume-accent)] text-[var(--lume-accent-foreground)] hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_88%,var(--lume-accent-2))]'
      : 'cursor-not-allowed bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_70%,transparent)] text-[var(--lume-text-muted)]',
  )
}

export function LumeComposer({
  tone,
  scale = 'compact',
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
  const sizing = scaleClasses[scale]
  const hasToolbarContent = Boolean(leadingTools) || Boolean(trailingTools)

  return (
    <div
      data-tone={tone}
      className={cn(
        'relative overflow-visible border backdrop-blur transition-[border-color,box-shadow,transform,background-color] duration-200 ease-out motion-reduce:transition-none',
        sizing.shell,
        className,
      )}
      style={{ ...palette.shell, ...shellStyle }}
    >
      <div className="relative">
        {topContent}

        <div className={cn(sizing.editor, editorClassName)}>{editorSlot}</div>

        {supportingContent}

        <div
          className={cn(
            'relative flex flex-wrap items-center gap-2.5 border-t',
            sizing.footer,
            footerClassName,
          )}
          style={{ borderColor: palette.dividerColor }}
        >
          {hasToolbarContent ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{leadingTools}</div>
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
