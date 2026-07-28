import { ChevronLeft, ChevronRight, CornerDownLeft, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
/**
 * 交互式覆盖层是否应在按下 Enter 时提交。
 * 焦点位于输入框 / 文本域时返回 false——保留原生输入与换行；
 * 焦点位于按钮时，仅当该按钮标记了 data-enter-submits（选项按钮）才返回 true，
 * 由覆盖层统一提交——原生 Enter→click 对选项按钮只会重复选中，无法提交；
 * 未标记的按钮（提交/忽略/开关）返回 false，交由原生 Enter→click 处理以避免重复触发；
 * 其余情况（焦点在卡片正文或未聚焦）返回 true。
 */
export function shouldSubmitInteractiveOverlayOnEnter(
  event: { key: string },
  target: EventTarget | null,
): boolean {
  if (event.key !== 'Enter') return false
  const element = target as { closest?: (selector: string) => Element | null } | null
  if (element?.closest?.('textarea, input')) return false
  if (element?.closest?.('button')) {
    return Boolean(element.closest('[data-enter-submits]'))
  }
  return true
}

interface InteractiveOverlayFrameProps {
  kind: string
  title: string
  children: ReactNode
  eyebrow?: string
  icon?: ReactNode
  busy?: boolean
  submitDisabled?: boolean
  submitLabel?: string
  compact?: boolean
  followTheme?: boolean
  showSubmit?: boolean
  meta?: ReactNode
  progress?: {
    current: number
    total: number
    onPrevious?: () => void
    onNext?: () => void
  }
  onSubmit: () => void
  onIgnore: () => void
}

export function InteractiveOverlayFrame({
  kind,
  title,
  children,
  eyebrow,
  icon,
  busy = false,
  submitDisabled = false,
  submitLabel = '提交',
  compact = false,
  followTheme = false,
  showSubmit = true,
  meta,
  progress,
  onSubmit,
  onIgnore,
}: InteractiveOverlayFrameProps) {
  if (compact) {
    return (
      <div className="px-3 pb-2 sm:px-6">
        <section
          data-interactive-overlay={kind}
          className={cn(
            'mx-auto max-w-[920px] rounded-[18px] border px-4 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.20)] sm:px-5',
            followTheme
              ? 'border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] text-[var(--lume-text-primary)]'
              : 'border-white/[0.06] bg-[#292929] text-white',
          )}
        >
          <div className="flex min-h-6 items-center gap-2.5">
            <div className="min-w-0 flex-1">
              <h3 className={cn(
                'truncate text-[15px] font-semibold leading-6',
                followTheme ? 'text-[var(--lume-text-primary)]' : 'text-[#f5f5f5]',
              )}>{title}</h3>
              {meta && <div className={cn(
                'truncate text-[10.5px] leading-4',
                followTheme ? 'text-[var(--lume-text-muted)]' : 'text-[#9c9c9c]',
              )}>{meta}</div>}
            </div>
            {progress && (
              <div className={cn(
                'flex shrink-0 items-center gap-0.5 text-[11px]',
                followTheme ? 'text-[var(--lume-text-muted)]' : 'text-[#929292]',
              )}>
                {progress.onPrevious || progress.onNext ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    disabled={!progress.onPrevious || progress.current <= 1}
                    onClick={progress.onPrevious}
                    aria-label="上一个选项"
                    className={followTheme
                      ? 'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)] disabled:opacity-30'
                      : 'text-[#777] hover:bg-white/[0.08] hover:text-white disabled:opacity-30'}
                  >
                    <ChevronLeft size={14} />
                  </Button>
                ) : null}
                <span className="min-w-[40px] text-center tabular-nums">{progress.current} of {progress.total}</span>
                {progress.onPrevious || progress.onNext ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    disabled={!progress.onNext || progress.current >= progress.total}
                    onClick={progress.onNext}
                    aria-label="下一个选项"
                    className={followTheme
                      ? 'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)] disabled:opacity-30'
                      : 'text-[#777] hover:bg-white/[0.08] hover:text-white disabled:opacity-30'}
                  >
                    <ChevronRight size={14} />
                  </Button>
                ) : null}
              </div>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={onIgnore}
              aria-label="关闭"
              className={followTheme
                ? 'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'
                : 'text-[#888] hover:bg-white/[0.08] hover:text-white'}
            >
              <X size={14} />
            </Button>
          </div>
          <div className="mt-2.5">{children}</div>
          <div className={cn(
            'mt-2.5 flex items-center gap-3',
            showSubmit ? 'justify-between' : 'justify-end',
          )}>
            <Button
              variant="ghost"
              type="button"
              onClick={onIgnore}
              className={cn(
                'h-7 rounded-full border px-2.5 text-[11px] font-semibold',
                followTheme
                  ? 'border-[var(--lume-border-subtle)] text-[var(--lume-text-secondary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'
                  : 'border-white/[0.12] text-[#d0d0d0] hover:bg-white/[0.08] hover:text-white',
              )}
            >
              跳过 <kbd className={cn(
                'ml-1 rounded px-1 py-0.5 font-mono text-[9px]',
                followTheme
                  ? 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-muted)]'
                  : 'bg-white/[0.08] text-[#999]',
              )}>ESC</kbd>
            </Button>
            {showSubmit && (
              <Button
                variant="ghost"
                type="button"
                onClick={onSubmit}
                disabled={busy || submitDisabled}
                className="h-8 min-w-[76px] rounded-full border border-white/[0.16] bg-white/[0.08] px-3 text-[12px] font-semibold text-white hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-35"
              >
                {busy ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : null}
                {submitLabel}
              </Button>
            )}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="px-3 pb-2 sm:px-6">
      <section
        data-interactive-overlay={kind}
        className="mx-auto max-w-[900px] overflow-hidden rounded-[22px] border border-black/[0.08] bg-white shadow-[0_16px_52px_rgba(15,23,42,0.16)]"
      >
        <div className="border-b border-[#edf0f4] bg-[linear-gradient(135deg,#fbfcff_0%,#f7f9fc_100%)] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-[#eaf2ff] text-[#4c8df6] shadow-[inset_0_0_0_1px_rgba(95,156,255,0.12)]">
                {icon}
              </div>
            )}
            <div className="min-w-0">
              {eyebrow && <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#7f8998]">{eyebrow}</p>}
              <h3 className="text-[16px] font-semibold leading-6 text-[#1f232b]">{title}</h3>
            </div>
            <span className="ml-auto shrink-0 rounded-full border border-[#dce7f9] bg-white/80 px-2 py-1 text-[11px] font-medium text-[#6c83a5]">
              等待你的决定
            </span>
          </div>
        </div>
        <div className="p-3 sm:p-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-[#edf0f4] bg-[#fcfcfd] px-3 py-2.5 sm:px-4">
          <Button
                variant="ghost"
            type="button"
            onClick={onIgnore}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-semibold text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            忽略 <kbd className="rounded-md bg-[#f0f0f2] px-1.5 py-0.5 font-mono text-[12px] text-[#5c626d]">ESC</kbd>
          </Button>
          <Button
                variant="ghost"
            type="button"
            onClick={onSubmit}
            disabled={busy || submitDisabled}
            className={cn(
              'inline-flex h-9 min-w-[104px] items-center justify-center gap-1.5 rounded-[11px] bg-[#1f232b] px-3.5 text-[13px] font-semibold text-white shadow-[0_6px_16px_rgba(31,35,43,0.18)] transition-colors hover:bg-[#343a46]',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : null}
            {submitLabel}
            {!busy && <CornerDownLeft size={15} />}
          </Button>
        </div>
      </section>
    </div>
  )
}
