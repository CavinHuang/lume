import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ContextWindowProgress } from './runtime-state-projections'

interface ContextWindowIndicatorProps {
  progress: ContextWindowProgress
  defaultOpen?: boolean
}

const CONTEXT_THRESHOLDS = [
  { pct: '60%', label: 'Snip + MicroCompact', dotClassName: 'bg-emerald-500', textClassName: 'text-emerald-500' },
  { pct: '~83%', label: 'Auto Compact (LLM)', dotClassName: 'bg-amber-500', textClassName: 'text-amber-500' },
  { pct: '85%', label: 'Collapse', dotClassName: 'bg-destructive', textClassName: 'text-destructive' },
]

const usageRecordGridClassName = 'grid grid-cols-[1fr_44px_44px_40px_44px_52px] border-t border-border/20 first:border-t-0'

export function ContextWindowIndicator({ progress, defaultOpen = false }: ContextWindowIndicatorProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'relative inline-flex h-8 w-8 items-center justify-center rounded-full border text-[10px] font-medium transition-colors',
          'border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_86%,transparent)] text-[var(--text-2)] hover:text-[var(--text-1)]',
        )}
        title="上下文窗口"
      >
        <ContextWindowRing progress={progress} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-[80] mb-2 w-[320px] overflow-hidden rounded-lg border border-border/60 bg-popover text-popover-foreground shadow-xl">
          <div className="p-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[12px] font-semibold text-foreground/80">上下文占用</span>
              <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-medium', contextProgressBadgeClass(progress.tone))}>
                {contextProgressLabel(progress.tone)}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
              <div
                className={cn('h-full rounded-full transition-[width]', contextProgressBarClass(progress.tone))}
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-foreground/45">
              <span className={cn('font-mono', contextProgressTextClass(progress.tone))}>
                {progress.usedTokens.toLocaleString()} ({progress.percent}%)
              </span>
              <span className="shrink-0 font-mono">{progress.contextWindow.toLocaleString()}</span>
            </div>
          </div>

          <div className="border-t border-border/35 px-3 py-2">
            <div className="space-y-1">
              {CONTEXT_THRESHOLDS.map((threshold) => (
                <div key={threshold.label} className="flex items-center gap-1.5 text-[10px] text-foreground/45">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', threshold.dotClassName)} />
                  <span className={cn('w-8 font-mono', threshold.textClassName)}>{threshold.pct}</span>
                  <span>{threshold.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border/35 px-3 py-2">
            <div className="mb-2 flex items-center justify-between text-[10px]">
              <span className="font-medium text-foreground/65">占用明细</span>
              <span className="font-mono text-foreground/40">{progress.remainingTokens.toLocaleString()} left</span>
            </div>
            {progress.sections.length > 0 ? (
              <div className="space-y-2">
                {progress.sections.map((section) => (
                  <div key={section.id}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-foreground/55">
                      <span className="min-w-0 truncate">{section.label}</span>
                      <span className="shrink-0 font-mono">
                        {section.tokens.toLocaleString()} · {section.percent}%
                      </span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.07]">
                      <div
                        className="h-full rounded-full bg-foreground/35"
                        style={{ width: `${section.percent}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-border/35 bg-foreground/[0.025] px-2 py-1.5 text-[10px] text-foreground/45">
                等待下一次 runtime usage 后显示输入、输出或 Kernel budget 分段。
              </div>
            )}
          </div>

          {progress.usage && (
            <div className="border-t border-border/35 px-3 py-2">
              <div className="mb-2 text-[10px] font-medium text-foreground/65">Token 明细</div>
              <div className="space-y-1">
                <UsageSummaryRow label="总输入" value={formatTokenNumber(progress.usage.inputTokens)} />
                {progress.usage.cachedTokens > 0 && (
                  <UsageSummaryRow
                    label="缓存命中"
                    value={formatTokenNumber(progress.usage.cachedTokens)}
                    valueClassName="text-emerald-500"
                  />
                )}
                <UsageSummaryRow label="总输出" value={formatTokenNumber(progress.usage.outputTokens)} />
                {typeof progress.usage.costUSD === 'number' && progress.usage.costUSD > 0 && (
                  <UsageSummaryRow
                    label="总费用"
                    value={formatCostUSD(progress.usage.costUSD)}
                    valueClassName="text-blue-500"
                    strong
                  />
                )}
              </div>
              {progress.usage.records && progress.usage.records.length > 0 && (
                <div className="mt-2 overflow-hidden rounded-md border border-border/30">
                  <div className={usageRecordGridClassName}>
                    {['调用方', '↑输入', '↑缓存', '命中率', '↓输出', '费用'].map((label, index) => (
                      <span
                        key={label}
                        className={cn(
                          'bg-foreground/[0.035] px-1.5 py-1 text-[9px] font-medium text-foreground/45',
                          index === 0 ? 'text-left' : 'text-right',
                        )}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                  <div className="max-h-[160px] overflow-y-auto">
                    {progress.usage.records.slice(0, 20).map((record, index) => (
                      <div key={`${record.callerLabel}:${index}`} className={usageRecordGridClassName}>
                        <span className="min-w-0 truncate px-1.5 py-1 text-[10px] text-foreground/65" title={record.callerLabel}>
                          {record.callerLabel}
                        </span>
                        <span className="px-1.5 py-1 text-right font-mono text-[10px] text-foreground/50">
                          {formatTokenNumber(record.inputTokens)}
                        </span>
                        <span className={cn(
                          'px-1.5 py-1 text-right font-mono text-[10px]',
                          record.cachedTokens > 0 ? 'text-emerald-500' : 'text-foreground/30',
                        )}>
                          {record.cachedTokens > 0 ? formatTokenNumber(record.cachedTokens) : '-'}
                        </span>
                        <span className={cn(
                          'px-1.5 py-1 text-right font-mono text-[10px]',
                          record.cacheHitRate !== null && record.cacheHitRate > 0 ? 'text-emerald-500' : 'text-foreground/30',
                        )}>
                          {record.cacheHitRate === null ? '?' : `${record.cacheHitRate}%`}
                        </span>
                        <span className="px-1.5 py-1 text-right font-mono text-[10px] text-foreground/50">
                          {formatTokenNumber(record.outputTokens)}
                        </span>
                        <span className={cn(
                          'px-1.5 py-1 text-right font-mono text-[10px]',
                          typeof record.costUSD === 'number' && record.costUSD > 0 ? 'text-blue-500' : 'text-foreground/30',
                        )}>
                          {typeof record.costUSD === 'number' && record.costUSD > 0 ? formatCostUSD(record.costUSD) : '-'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function UsageSummaryRow({
  label,
  value,
  valueClassName,
  strong = false,
}: {
  label: string
  value: string
  valueClassName?: string
  strong?: boolean
}) {
  return (
    <div className={cn(
      'flex items-center justify-between gap-3 text-[10px] text-foreground/50',
      strong && 'border-t border-border/25 pt-1 font-semibold',
    )}>
      <span>{label}</span>
      <span className={cn('shrink-0 font-mono', valueClassName)}>{value}</span>
    </div>
  )
}

function ContextWindowRing({ progress }: { progress: ContextWindowProgress }) {
  const radius = 11
  const circumference = 2 * Math.PI * radius
  const visibleLength = circumference * Math.min(progress.percent, 100) / 100
  return (
    <>
      <svg
        width="26"
        height="26"
        viewBox="0 0 26 26"
        className="absolute left-1/2 top-1/2"
        style={{ transform: 'translate(-50%, -50%) rotate(-90deg)' }}
      >
        <circle
          cx="13"
          cy="13"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-foreground/10"
        />
        <circle
          cx="13"
          cy="13"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${visibleLength} ${circumference}`}
          className={contextProgressTextClass(progress.tone)}
        />
      </svg>
      <span className={cn('relative z-10 tabular-nums leading-none', contextProgressTextClass(progress.tone))}>
        {progress.percent}
      </span>
    </>
  )
}

function contextProgressLabel(tone: ContextWindowProgress['tone']): string {
  if (tone === 'danger') return 'Collapse'
  if (tone === 'warning') return 'Auto Compact'
  if (tone === 'active') return 'Snip'
  return '正常'
}

function contextProgressBadgeClass(tone: ContextWindowProgress['tone']): string {
  if (tone === 'danger') return 'border-destructive/25 bg-destructive/5 text-destructive'
  if (tone === 'warning') return 'border-amber-500/25 bg-amber-500/5 text-amber-500'
  if (tone === 'active') return 'border-blue-500/25 bg-blue-500/5 text-blue-500'
  return 'border-foreground/10 bg-foreground/[0.025] text-foreground/45'
}

function contextProgressBarClass(tone: ContextWindowProgress['tone']): string {
  if (tone === 'danger') return 'bg-destructive'
  if (tone === 'warning') return 'bg-amber-500'
  if (tone === 'active') return 'bg-blue-500'
  return 'bg-foreground/25'
}

function contextProgressTextClass(tone: ContextWindowProgress['tone']): string {
  if (tone === 'danger') return 'text-destructive'
  if (tone === 'warning') return 'text-amber-500'
  if (tone === 'active') return 'text-blue-500'
  return 'text-foreground/35'
}

function formatTokenNumber(value: number): string {
  return value.toLocaleString()
}

function formatCostUSD(value: number): string {
  return `$${value.toFixed(4)}`
}
