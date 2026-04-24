import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { LumeComposerTone } from './lume-composer-state'

type LumeComposerScale = 'compact' | 'hero'

interface LumeComposerProps {
  tone: LumeComposerTone
  scale?: LumeComposerScale
  className?: string
  editorClassName?: string
  footerClassName?: string
  editorSlot: ReactNode
  supportingContent?: ReactNode
  leadingTools?: ReactNode
  trailingTools?: ReactNode
  actionSlot: ReactNode
}

type LumeComposerActionSize = 'compact' | 'hero'

const toneStyles: Record<
  LumeComposerTone,
  {
    shell: {
      borderColor: string
      background: string
      boxShadow: string
    }
    glow: {
      background: string
      opacity: number
    }
    dividerColor: string
  }
> = {
  idle: {
    shell: {
      borderColor: 'color-mix(in oklab, var(--border-strong) 54%, transparent)',
      background:
        'linear-gradient(180deg, color-mix(in oklab, var(--surface-1) 95%, transparent), color-mix(in oklab, var(--surface-2) 84%, transparent))',
      boxShadow: '0 24px 48px -38px hsl(var(--shadow-panel) / 0.34)',
    },
    glow: {
      background:
        'radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--brand) 12%, transparent) 0%, transparent 58%)',
      opacity: 0.72,
    },
    dividerColor: 'color-mix(in oklab, var(--border-strong) 42%, transparent)',
  },
  ready: {
    shell: {
      borderColor: 'color-mix(in oklab, var(--brand) 26%, var(--border-strong))',
      background:
        'linear-gradient(180deg, color-mix(in oklab, var(--surface-1) 96%, transparent), color-mix(in oklab, var(--brand) 9%, var(--surface-2)) 100%)',
      boxShadow: '0 28px 56px -36px color-mix(in oklab, var(--brand) 28%, transparent)',
    },
    glow: {
      background:
        'radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--brand) 20%, transparent) 0%, transparent 60%), radial-gradient(circle at 80% 0%, color-mix(in oklab, var(--brand-2) 16%, transparent) 0%, transparent 48%)',
      opacity: 0.96,
    },
    dividerColor: 'color-mix(in oklab, var(--brand) 18%, var(--border-strong))',
  },
  streaming: {
    shell: {
      borderColor: 'color-mix(in oklab, var(--brand-2) 28%, var(--border-strong))',
      background:
        'linear-gradient(180deg, color-mix(in oklab, var(--surface-1) 95%, transparent), color-mix(in oklab, var(--brand-2) 10%, var(--surface-2)) 100%)',
      boxShadow: '0 28px 58px -34px color-mix(in oklab, var(--brand-2) 30%, transparent)',
    },
    glow: {
      background:
        'radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--brand-2) 22%, transparent) 0%, transparent 58%), radial-gradient(circle at 15% 0%, color-mix(in oklab, var(--brand) 14%, transparent) 0%, transparent 45%)',
      opacity: 1,
    },
    dividerColor: 'color-mix(in oklab, var(--brand-2) 18%, var(--border-strong))',
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
    footer: 'px-3 pb-3 pt-3',
  },
  hero: {
    shell: 'rounded-[1.55rem]',
    editor: 'px-4 pt-4 pb-2',
    footer: 'px-3 pb-3 pt-3',
  },
}

const actionSizeClasses: Record<LumeComposerActionSize, string> = {
  compact: 'h-10 px-4 text-[12px]',
  hero: 'h-11 px-5 text-[13px]',
}

export function getLumeComposerPrimaryActionClassName({
  enabled,
  size = 'compact',
}: {
  enabled: boolean
  size?: LumeComposerActionSize
}) {
  return cn(
    'inline-flex items-center gap-2 rounded-full font-medium transition-all',
    actionSizeClasses[size],
    enabled
      ? 'bg-[linear-gradient(135deg,var(--brand),var(--brand-2))] text-[var(--brand-foreground)] shadow-[0_18px_34px_-24px_color-mix(in_oklab,var(--brand)_82%,transparent)] hover:translate-y-[-1px]'
      : 'cursor-not-allowed bg-[color:color-mix(in_oklab,var(--surface-3)_84%,transparent)] text-[var(--text-3)]',
  )
}

export function LumeComposer({
  tone,
  scale = 'compact',
  className,
  editorClassName,
  footerClassName,
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
        'relative overflow-hidden border backdrop-blur transition-[border-color,box-shadow,transform] duration-200',
        sizing.shell,
        className,
      )}
      style={palette.shell}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-200"
        style={palette.glow}
      />

      <div className="relative">
        <div className={cn(sizing.editor, editorClassName)}>{editorSlot}</div>

        {supportingContent}

        <div
          className={cn(
            'relative flex flex-wrap items-center gap-3 border-t',
            sizing.footer,
            footerClassName,
          )}
          style={{ borderColor: palette.dividerColor }}
        >
          {hasToolbarContent ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{leadingTools}</div>
          ) : null}
          {trailingTools ? (
            <div className="flex items-center gap-2">{trailingTools}</div>
          ) : null}
          <div className={cn('shrink-0', hasToolbarContent && 'ml-auto')}>{actionSlot}</div>
        </div>
      </div>
    </div>
  )
}
