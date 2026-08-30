import { useEffect, useState } from 'react'
import type { TaskProgressViewEvent } from './runtime-message-view'
import { cn } from '@/lib/utils'
import TaskRows, { type TaskDetail, type TaskRow as TaskRowModel } from './TaskRows'

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
 * hover 弹出任务面板（TaskRows 组件）。终态（完成/取消）短暂停留后自动消失，失败保留。
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
              'absolute bottom-full left-1/2 mb-2 w-[360px] -translate-x-1/2 p-1.5 overflow-hidden rounded-2xl border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_97%,transparent)] shadow-[0_24px_48px_-24px_hsl(var(--lume-shadow-panel)/0.5)] backdrop-blur transition-all duration-150',
              hovered ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0',
            )}
          >
            <div className="px-2 pb-2 pt-1.5">
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
            <div className="agent-message-scrollbar max-h-[320px] overflow-y-auto">
              <TaskRows
                variant="List"
                labels={{ completed: '已完成', failed: '失败' }}
                rows={event.tasks.map((task, index) => toTaskRowModel(task, index))}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function getTaskRowDetails(task: TaskProgressViewEvent['tasks'][number], title: string): TaskDetail[] {
  const details: TaskDetail[] = []
  const attemptMeta = task.attemptCount && task.attemptCount > 1 ? `第 ${task.attemptCount} 次` : ''
  if (task.status === 'failed' && task.error) details.push({ label: task.error, meta: attemptMeta })
  else if (task.blockedReason) details.push({ label: task.blockedReason, meta: attemptMeta })
  if (task.description && task.description !== title && !details.some((d) => d.label === task.description)) {
    details.push({ label: task.description, meta: details.length === 0 ? attemptMeta : '' })
  }
  if (task.status === 'completed' && task.result && task.result !== title) {
    details.push({ label: task.result, meta: details.length === 0 ? attemptMeta : '' })
  }
  return details
}

/* 真实任务状态 → TaskRows 行模型：
 * completed/skipped → "done"；running/in_progress → "running"；
 * pending/failed → "sequence" + phase（覆盖组件的演示时序，状态由事件驱动） */
function toTaskRowModel(task: TaskProgressViewEvent['tasks'][number], index: number): TaskRowModel {
  const title = task.title || task.subject || task.description || task.id
  const running = task.status === 'running' || task.status === 'in_progress'
  const done = task.status === 'completed' || task.status === 'skipped'
  return {
    key: task.id,
    label: title,
    amount: task.attemptCount && task.attemptCount > 1 ? `第 ${task.attemptCount} 次` : '',
    status: done ? 'done' : running ? 'running' : 'sequence',
    phase: task.status === 'failed' ? 'failed' : task.status === 'pending' ? 'pending' : undefined,
    step: index + 1,
    details: getTaskRowDetails(task, title),
  }
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
