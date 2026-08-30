import { useEffect, useState } from 'react'
import { Check, ChevronDown, RotateCw, SkipForward, X } from 'lucide-react'
import type { TaskProgressViewEvent } from './runtime-message-view'
import { cn } from '@/lib/utils'

export function getTaskProgressStatusText(event: TaskProgressViewEvent): string {
  const current = event.currentTaskId
    ? event.tasks.find((task) => task.id === event.currentTaskId)
    : event.tasks.find((task) => task.status === 'running')
  const title = current?.title || current?.description || current?.id
  if (event.status === 'completed') return '任务已完成'
  if (event.status === 'failed') return title ? `执行失败：${title}` : '任务执行失败'
  if (event.status === 'cancelled') return '任务已取消'
  if (event.status === 'waiting_for_user') return title ? `等待你的确认：${title}` : event.message?.trim() || '等待你的确认'
  if (event.status === 'waiting_for_permission') return title ? `等待授权：${title}` : event.message?.trim() || '等待授权'
  if (event.status === 'pending') return title ? `准备执行：${title}` : event.message?.trim() || '准备执行任务'
  if (title) return `正在执行：${title}`
  return event.message?.trim() || '正在执行任务'
}

const AUTO_DISMISS_STATUSES = new Set(['completed', 'cancelled'])

/**
 * 任务进度胶囊：悬浮在输入框上方，展示「任务进行中 n/m」；
 * hover 弹出任务面板（TaskRows 设计语言：序号进度环 / 实心状态徽章 /
 * 状态 pill / 可展开的 detail 行）。终态（完成/取消）短暂停留后自动消失，失败保留。
 */
export function TaskProgressCapsule({ event }: { event: TaskProgressViewEvent }) {
  const [hovered, setHovered] = useState(false)
  const [dismissed, setDismissed] = useState(() => AUTO_DISMISS_STATUSES.has(event.status))

  useEffect(() => {
    if (!AUTO_DISMISS_STATUSES.has(event.status)) {
      setDismissed(false)
      return undefined
    }
    const timeoutId = window.setTimeout(() => setDismissed(true), 4000)
    return () => window.clearTimeout(timeoutId)
  }, [event])

  if (dismissed) return null

  const completedCount = event.tasks.filter((task) => task.status === 'completed' || task.status === 'skipped').length
  const failedCount = event.tasks.filter((task) => task.status === 'failed').length
  const total = event.tasks.length
  const isActive = event.status === 'pending' || event.status === 'in_progress' || event.status === 'running'
  const isWaiting = event.status === 'waiting_for_user' || event.status === 'waiting_for_permission'
  const label = event.status === 'failed'
    ? '任务失败'
    : isWaiting
      ? (event.status === 'waiting_for_user' ? '等待确认' : '等待授权')
      : event.status === 'cancelled'
        ? '任务已取消'
        : event.status === 'completed'
          ? '任务已完成'
          : '任务进行中'
  const ringTone = failedCount > 0 || event.status === 'failed'
    ? 'var(--destructive)'
    : isWaiting
      ? 'var(--lume-warning)'
      : event.status === 'completed'
        ? 'var(--lume-success)'
        : isActive
          ? 'var(--lume-accent)'
          : 'var(--lume-text-muted)'
  const progressRatio = total > 0 ? completedCount / total : 0

  return (
    <div className="pointer-events-none absolute bottom-3 left-0 right-0 z-10 flex justify-center px-3">
      <div
        className="pointer-events-auto relative"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <button
          type="button"
          data-task-progress={event.status}
          aria-expanded={hovered}
          aria-label={`${label} ${completedCount}/${total}`}
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
          className={cn(
            'flex max-w-[360px] items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium shadow-[0_12px_30px_-24px_hsl(var(--lume-shadow-panel)/0.72)] backdrop-blur transition-colors',
            failedCount > 0 || event.status === 'failed'
              ? 'border-destructive/25 text-destructive'
              : 'border-[var(--lume-border-subtle)] text-[var(--lume-text-secondary)] hover:border-[var(--lume-border-strong)]',
            'bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_94%,transparent)]',
          )}
        >
          <ProgressRing ratio={progressRatio} stroke={ringTone} />
          <span className={cn('shrink-0', isActive && 'lume-shimmer-text')}>{label}</span>
          {total > 0 && (
            <span className="shrink-0 tabular-nums text-foreground/50">
              {completedCount}/{total}{failedCount > 0 ? ` · ${failedCount} 失败` : ''}
            </span>
          )}
        </button>

        {total > 0 && (
          <div
            role="region"
            aria-label="任务列表"
            className={cn(
              'absolute bottom-full left-1/2 mb-2 w-[340px] -translate-x-1/2 overflow-hidden rounded-2xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] shadow-[0_24px_48px_-24px_hsl(var(--lume-shadow-panel)/0.5)] backdrop-blur transition-all duration-150',
              hovered ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0',
            )}
          >
            <div className="px-3 pb-2 pt-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn('min-w-0 truncate text-[12px] font-medium text-[var(--lume-text-secondary)]', isActive && 'lume-shimmer-text')}>
                  {getTaskProgressStatusText(event)}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--lume-text-muted)]">
                  {completedCount}/{total}{failedCount > 0 ? ` · ${failedCount} 失败` : ''}
                </span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-[color:color-mix(in_oklab,var(--lume-text-muted)_18%,transparent)]">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-500',
                    failedCount > 0 ? 'bg-destructive' : 'bg-[var(--lume-accent)]',
                  )}
                  style={{ width: `${Math.round(progressRatio * 100)}%` }}
                />
              </div>
            </div>
            <div className="agent-message-scrollbar max-h-[300px] overflow-y-auto border-t border-[var(--lume-border-subtle)]">
              {event.tasks.map((task, index) => (
                <TaskRowItem key={task.id} task={task} index={index} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

type TaskProgressTask = TaskProgressViewEvent['tasks'][number]
type TaskRowDetail = { label: string, meta: string }

function getTaskRowDetails(task: TaskProgressTask): TaskRowDetail[] {
  const details: TaskRowDetail[] = []
  const attemptMeta = task.attemptCount && task.attemptCount > 1 ? `第 ${task.attemptCount} 次` : ''
  if (task.status === 'failed' && task.error) details.push({ label: task.error, meta: attemptMeta })
  else if (task.blockedReason) details.push({ label: task.blockedReason, meta: attemptMeta })
  if (task.description && task.description !== task.title && !details.some((d) => d.label === task.description)) {
    details.push({ label: task.description, meta: details.length === 0 ? attemptMeta : '' })
  }
  if (task.status === 'completed' && task.result && task.result !== task.title) {
    details.push({ label: task.result, meta: details.length === 0 ? attemptMeta : '' })
  }
  return details
}

function TaskRowItem({ task, index }: { task: TaskProgressTask, index: number }) {
  // 手动展开/收起优先；未操作过时跟随运行态（运行中的任务自动展开）
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const running = task.status === 'running' || task.status === 'in_progress'
  const open = manualOpen ?? running
  const title = task.title || task.subject || task.description || task.id
  const details = getTaskRowDetails(task)
  const done = task.status === 'completed'
  const failed = task.status === 'failed'
  const skipped = task.status === 'skipped'

  const badge = done ? (
    <StatusBadge tone="green"><Check size={13} strokeWidth={3} /></StatusBadge>
  ) : failed ? (
    <StatusBadge tone="red"><X size={12} strokeWidth={3.5} /></StatusBadge>
  ) : skipped ? (
    <StatusBadge tone="muted"><SkipForward size={12} strokeWidth={2.6} /></StatusBadge>
  ) : (
    <SpinnerRing active={running} step={index + 1} />
  )

  const pill = done ? (
    <StatusPill tone="green">已完成</StatusPill>
  ) : failed ? (
    <StatusPill tone="red">
      失败
      <RotateCw size={11} strokeWidth={3} className="animate-spin motion-reduce:animate-none" />
    </StatusPill>
  ) : skipped ? (
    <StatusPill tone="muted">已跳过</StatusPill>
  ) : null

  return (
    <div
      className={cn(
        'animate-in fade-in slide-in-from-bottom-1 fill-mode-both border-b border-[var(--lume-border-subtle)] duration-300 last:border-b-0 motion-reduce:animate-none',
        'transition-colors hover:bg-[color:color-mix(in_oklab,var(--lume-text-secondary)_6%,transparent)]',
      )}
      style={{ animationDelay: `${Math.min(index, 8) * 80}ms` }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
        className="flex h-11 w-full items-center gap-2.5 px-2.5 text-left"
      >
        <span className="flex size-6 shrink-0 items-center justify-center">{badge}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] font-medium',
            running ? 'text-[var(--lume-text-primary)]' : 'text-[var(--lume-text-secondary)]',
            (done || skipped) && 'text-[var(--lume-text-muted)]',
            failed && 'text-destructive',
          )}
        >
          {title}
        </span>
        {pill}
        <span aria-hidden="true" className="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--lume-text-muted)]">
          <ChevronDown
            size={15}
            strokeWidth={2.2}
            className="transition-transform duration-300"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          />
        </span>
      </button>

      {/* dropdown detail — 与 Chain of Thought 相同的展开语法（grid-rows 0fr→1fr） */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="overflow-hidden">
          {open && details.length > 0 && (
            <div key={`details-${index}`} className="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
              <span aria-hidden="true" className="mx-auto h-full w-px bg-[var(--lume-border-subtle)]" />
              <div className="flex flex-col gap-1.5">
                {details.map((detail, detailIndex) => (
                  <div
                    key={`${detail.label}-${detailIndex}`}
                    className="flex animate-in fade-in slide-in-from-bottom-1 items-center justify-between gap-2 fill-mode-both duration-300 motion-reduce:animate-none"
                    style={{ animationDelay: `${120 + detailIndex * 100}ms` }}
                  >
                    <span className={cn('min-w-0 text-[12px] text-[var(--lume-text-secondary)]', failed && 'text-destructive/80')}>{detail.label}</span>
                    {detail.meta && (
                      <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-[var(--lume-text-muted)]">{detail.meta}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SpinnerRing({ active, step }: { active?: boolean, step: number }) {
  const size = 24
  const stroke = 2
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--lume-border-subtle)" strokeWidth={stroke} />
        {active && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--lume-accent)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${c * 0.28} ${c * 0.72}`}
            className="animate-spin [transform-origin:center] motion-reduce:animate-none"
          />
        )}
      </svg>
      <span className="relative text-[10.5px] font-semibold tabular-nums text-[var(--lume-text-secondary)]">{step}</span>
    </span>
  )
}

function StatusBadge({ tone, children }: { tone: 'green' | 'red' | 'muted', children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'flex size-5.5 shrink-0 items-center justify-center rounded-full text-white animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none',
        tone === 'green' && 'bg-[var(--lume-success)]',
        tone === 'red' && 'bg-destructive',
        tone === 'muted' && 'bg-[color:color-mix(in_oklab,var(--lume-text-muted)_50%,transparent)]',
      )}
    >
      {children}
    </span>
  )
}

function StatusPill({ tone, children }: { tone: 'green' | 'red' | 'muted', children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium animate-in fade-in duration-200 motion-reduce:animate-none',
        tone === 'green' && 'bg-[color:color-mix(in_oklab,var(--lume-success)_14%,transparent)] text-[var(--lume-success)]',
        tone === 'red' && 'bg-[color:color-mix(in_oklab,var(--destructive)_14%,transparent)] text-destructive',
        tone === 'muted' && 'bg-[color:color-mix(in_oklab,var(--lume-text-muted)_12%,transparent)] text-[var(--lume-text-muted)]',
      )}
    >
      {children}
    </span>
  )
}

function ProgressRing({ ratio, stroke }: { ratio: number, stroke: string }) {
  const r = 7
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - Math.min(Math.max(ratio, 0), 1))
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0">
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2" className="text-foreground/15" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
        className="transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  )
}
