import { useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { agentRuntimeEventsAtom } from '@/atoms'
import { cn } from '@/lib/utils'
import { executeTaskContract } from '@/lib/desktop-api'
import { CheckCircle, Circle, ClipboardList, Loader2, PlayCircle, RotateCcw, SkipForward, XCircle } from 'lucide-react'

import type { AgentTaskRunTask, LumeRuntimeEvent } from '@lume/shared'

interface TaskProgressPanelProps {
  threadId: string
}

const statusIcon = {
  pending: <Circle size={14} className="text-[var(--text-3)]" />,
  running: <Loader2 size={14} className="animate-spin text-[var(--brand)]" />,
  completed: <CheckCircle size={14} className="text-emerald-500" />,
  failed: <XCircle size={14} className="text-destructive" />,
  skipped: <SkipForward size={14} className="text-[var(--text-3)]" />,
}

const statusLabel = {
  pending: '待开始',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
}

type TaskProgressEvent = Extract<LumeRuntimeEvent, { type: 'task.progress' }>

export function canContinueTaskProgress(progress: TaskProgressEvent | undefined): boolean {
  return progress?.status === 'pending' || progress?.status === 'running' || progress?.status === 'failed'
}

export function canRetryTaskProgress(progress: TaskProgressEvent | undefined): boolean {
  return progress?.status === 'failed' && progress.tasks.some((task) => task.status === 'failed')
}

export function canSkipTaskProgress(progress: TaskProgressEvent | undefined): boolean {
  return (progress?.status === 'pending' || progress?.status === 'failed')
    && progress.tasks.some((task) => task.status === 'failed' || task.status === 'pending')
}

export function shouldShowTaskEmptyState(
  progress: TaskProgressEvent | undefined,
): progress is undefined {
  return !progress
}

export function getTaskProgressItems(
  progress: TaskProgressEvent | undefined,
): AgentTaskRunTask[] {
  return progress?.tasks ?? []
}

export function TaskProgressPanel({ threadId }: TaskProgressPanelProps) {
  const runtimeEventState = useAtomValue(agentRuntimeEventsAtom)[threadId]
  const activeItemRef = useRef<HTMLDivElement>(null)
  const [continueBusy, setContinueBusy] = useState(false)

  const latestTaskProgress = [...(runtimeEventState?.events ?? [])]
    .reverse()
    .find((event): event is TaskProgressEvent => event.type === 'task.progress')
  const progressItems = getTaskProgressItems(latestTaskProgress)
  const completedCount = progressItems.filter((item) => item.status === 'completed' || item.status === 'skipped').length
  const failedCount = progressItems.filter((item) => item.status === 'failed').length
  const progressValue = progressItems.length > 0 ? Math.round((completedCount / progressItems.length) * 100) : 0
  const activeItem = progressItems.find((item) => item.status === 'running')
  const canContinueTasks = canContinueTaskProgress(latestTaskProgress)
  const canRetryTasks = canRetryTaskProgress(latestTaskProgress)
  const canSkipTasks = canSkipTaskProgress(latestTaskProgress)

  const runTaskIntent = async (intent: 'continue' | 'retry' | 'skip') => {
    const contractId = latestTaskProgress?.contractId
    if (!contractId) return
    setContinueBusy(true)
    try {
      await executeTaskContract({
        threadId,
        contractId,
        intent,
      })
    } catch (error) {
      console.error('[TaskProgressPanel] 继续执行任务失败:', error)
    } finally {
      setContinueBusy(false)
    }
  }

  // 自动滚动到当前执行任务
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [progressItems])

  if (shouldShowTaskEmptyState(latestTaskProgress)) {
    return (
      <div className="flex h-full flex-col bg-[var(--surface-2)]">
        <TaskProgressPanelHeader />
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="space-y-2">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-3)]">
              <ClipboardList size={17} />
            </div>
            <p className="text-[13px] font-medium text-[var(--text-2)]">暂无任务</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--surface-2)]">
      <TaskProgressPanelHeader />
      <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-3 py-3">
        <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_90%,transparent)] p-3 shadow-[0_18px_40px_-34px_hsl(var(--shadow-panel)/0.34)]">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]">
              <PlayCircle size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-[var(--text-1)]">
                任务进度
              </div>
              {latestTaskProgress.message && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-3)]">
                  {latestTaskProgress.message}
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[10.5px] text-[var(--text-3)]">
            <span>{completedCount}/{progressItems.length} 已完成</span>
            <span>{failedCount > 0 ? `${failedCount} 个失败` : activeItem ? '正在执行' : statusLabel[progressItems[0]?.status ?? 'pending']}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]">
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,var(--brand),var(--brand-2))] transition-[width] duration-300"
              style={{ width: `${progressValue}%` }}
            />
          </div>
          {canContinueTasks && (
            <button
              type="button"
              disabled={continueBusy}
              onClick={() => void runTaskIntent('continue')}
              className="mt-3 h-8 w-full rounded-lg bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] px-2 text-[11px] font-medium text-[var(--brand)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_14%,var(--surface-1))] disabled:opacity-50"
            >
              {continueBusy ? '继续中...' : '继续执行'}
            </button>
          )}
          {(canRetryTasks || canSkipTasks) && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {canRetryTasks && (
                <button
                  type="button"
                  disabled={continueBusy}
                  onClick={() => void runTaskIntent('retry')}
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-amber-500/10 px-2 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/15 disabled:opacity-50"
                >
                  <RotateCcw size={12} />
                  重试
                </button>
              )}
              {canSkipTasks && (
                <button
                  type="button"
                  disabled={continueBusy}
                  onClick={() => void runTaskIntent('skip')}
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-[var(--surface-2)] px-2 text-[11px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] disabled:opacity-50"
                >
                  <SkipForward size={12} />
                  跳过
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        <div className="space-y-2">
          {progressItems.length === 0 && (
            <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] bg-[var(--surface-1)] px-3 py-3 text-[12px] leading-relaxed text-[var(--text-3)]">
              任务进度尚未生成。开始执行后会在这里显示任务。
            </div>
          )}
          {progressItems.map((step, index) => (
            <div
              key={step.id}
              ref={step.status === 'running' ? activeItemRef : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-xl border bg-[var(--surface-1)] px-3 py-2.5 text-[12px] transition-colors',
                step.status === 'running'
                  ? 'border-[color:color-mix(in_oklab,var(--brand)_34%,var(--border-strong))] shadow-[0_18px_40px_-36px_color-mix(in_oklab,var(--brand)_60%,transparent)]'
                  : 'border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)]',
                step.status === 'failed' && 'border-destructive/24 bg-destructive/5'
              )}
            >
              <span className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-[10.5px] font-semibold',
                step.status === 'completed' && 'border-emerald-500/18 bg-emerald-500/8',
                step.status === 'running' && 'border-[color:color-mix(in_oklab,var(--brand)_24%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--surface-1))]',
                step.status === 'pending' && 'border-[var(--border)] bg-[var(--surface-2)]',
                step.status === 'failed' && 'border-destructive/20 bg-destructive/8',
              )}>
                {step.status === 'pending' ? index + 1 : statusIcon[step.status]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'block min-w-0 flex-1 truncate text-[12.5px] font-medium leading-5',
                    (step.status === 'completed' || step.status === 'skipped') ? 'text-[var(--text-3)]' : 'text-[var(--text-1)]'
                  )}>
                    {formatProgressItemTitle(step)}
                  </span>
                  <span className={cn(
                    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    step.status === 'completed' && 'bg-emerald-500/10 text-emerald-600',
                    step.status === 'running' && 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]',
                    step.status === 'pending' && 'bg-[var(--surface-2)] text-[var(--text-3)]',
                    step.status === 'failed' && 'bg-destructive/10 text-destructive',
                    step.status === 'skipped' && 'bg-[var(--surface-2)] text-[var(--text-3)]',
                  )}>
                    {statusLabel[step.status]}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TaskProgressPanelHeader() {
  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
        <ClipboardList size={15} className="text-[var(--brand)]" />
        任务进度
      </div>
    </div>
  )
}

export function formatProgressItemTitle(step: AgentTaskRunTask): string {
  return step.title || step.description || step.id
}
