import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { agentPendingInteractiveAtom, agentPlanStateAtom, agentRunEventsAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { executePlan, getPendingInteractive, listStructuredPlans, submitPlanApproval } from '@/lib/desktop-api'
import { CheckCircle, Circle, ClipboardList, Loader2, PlayCircle, RotateCcw, SkipForward, XCircle } from 'lucide-react'
import { removePendingPlanApproval, upsertPendingPlanApproval } from '@/hooks/pending-interactive-state'
import type { AgentStructuredPlan, AgentStructuredPlanStep } from '@lume/shared'

interface PlanPanelProps {
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

export function canContinueStructuredPlan(plan: AgentStructuredPlan | undefined): boolean {
  if (!plan) return false
  if (plan.status !== 'approved' && plan.status !== 'executing' && plan.status !== 'failed') return false
  return plan.steps.some((step) => step.status === 'pending' || step.status === 'running' || step.status === 'failed')
}

export function canRetryStructuredPlan(plan: AgentStructuredPlan | undefined): boolean {
  if (!plan || plan.status !== 'failed') return false
  return plan.steps.some((step) => step.status === 'failed')
}

export function canSkipStructuredPlan(plan: AgentStructuredPlan | undefined): boolean {
  if (!plan || (plan.status !== 'approved' && plan.status !== 'failed')) return false
  return plan.steps.some((step) => step.status === 'failed' || step.status === 'pending')
}

export function shouldShowPlanEmptyState(
  plan: AgentStructuredPlan | undefined,
  pendingApproval: unknown,
): boolean {
  return !plan && !pendingApproval
}

export function PlanPanel({ threadId }: PlanPanelProps) {
  const pendingInteractive = useAtomValue(agentPendingInteractiveAtom)[threadId]
  const planState = useAtomValue(agentPlanStateAtom)[threadId]
  const runEventState = useAtomValue(agentRunEventsAtom)[threadId]
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const activeStepRef = useRef<HTMLDivElement>(null)
  const [structuredPlans, setStructuredPlans] = useState<AgentStructuredPlan[]>([])
  const [approvalBusy, setApprovalBusy] = useState(false)
  const [continueBusy, setContinueBusy] = useState(false)

  const planRefreshKey = useMemo(() => {
    return (runEventState?.events ?? [])
      .filter((event) => (
        event.type === 'run_completed'
        || event.type === 'plan_progress'
        || (event.type === 'tool_call_completed' && event.item.toolName === 'PlanWrite')
      ))
      .map((event) => event.type === 'tool_call_completed' ? event.item.createdAt : event.type === 'plan_progress' ? event.createdAt : event.type)
      .join('|')
  }, [runEventState?.events])
  const planStateRefreshKey = `${planState?.phase ?? 'none'}:${planState?.steps?.length ?? 0}`

  const loadStructuredPlans = useCallback(() => {
    let cancelled = false
    void listStructuredPlans({ threadId })
      .then((result) => {
        if (!cancelled) {
          setStructuredPlans(result.plans)
        }
      })
      .catch((error) => {
        console.error('[PlanPanel] 加载结构化 Plan 失败:', error)
        if (!cancelled) setStructuredPlans([])
      })
    return () => {
      cancelled = true
    }
  }, [threadId])

  const loadPendingPlanApprovals = useCallback(() => {
    let cancelled = false
    void getPendingInteractive({ threadId })
      .then((states) => {
        if (cancelled) return
        setPendingInteractive((prev) => {
          let next = prev
          for (const state of states) {
            for (const request of state.planApprovals ?? []) {
              next = upsertPendingPlanApproval(next, request)
            }
          }
          return next
        })
      })
      .catch((error) => console.error('[PlanPanel] 加载 plan approval 失败:', error))
    return () => {
      cancelled = true
    }
  }, [setPendingInteractive, threadId])

  useEffect(() => loadStructuredPlans(), [loadStructuredPlans, planRefreshKey, planStateRefreshKey])

  useEffect(() => loadPendingPlanApprovals(), [loadPendingPlanApprovals, planRefreshKey, planStateRefreshKey])

  const latestStructuredPlan = [...structuredPlans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const steps = latestStructuredPlan?.steps ?? []
  const pendingPlanApproval = pendingInteractive?.planApprovals?.find((item) => (
    item.planId === latestStructuredPlan?.id
  )) ?? pendingInteractive?.planApprovals?.[0]
  const completedCount = steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length
  const failedCount = steps.filter((step) => step.status === 'failed').length
  const progressValue = steps.length > 0 ? Math.round((completedCount / steps.length) * 100) : 0
  const activeStep = steps.find((step) => step.status === 'running')
  const canContinuePlan = !pendingPlanApproval && canContinueStructuredPlan(latestStructuredPlan)
  const canRetryPlan = !pendingPlanApproval && canRetryStructuredPlan(latestStructuredPlan)
  const canSkipPlan = !pendingPlanApproval && canSkipStructuredPlan(latestStructuredPlan)

  const runPlanIntent = async (intent: 'continue' | 'retry' | 'skip') => {
    if (!latestStructuredPlan) return
    setContinueBusy(true)
    try {
      await executePlan({
        threadId,
        planId: latestStructuredPlan.id,
        intent,
      })
    } catch (error) {
      console.error('[PlanPanel] 继续执行计划失败:', error)
    } finally {
      setContinueBusy(false)
    }
  }

  const resolveApproval = async (decision: 'approve' | 'reject') => {
    if (!pendingPlanApproval) return
    setApprovalBusy(true)
    try {
      const result = await submitPlanApproval({
        threadId,
        planId: pendingPlanApproval.planId,
        decision,
        execute: decision === 'approve',
      })
      if (result.ok) {
        setPendingInteractive((prev) => removePendingPlanApproval(prev, threadId, pendingPlanApproval.planId))
        setStructuredPlans((prev) => prev.map((item) => item.id === pendingPlanApproval.planId
          ? {
              ...item,
              status: decision === 'approve' ? 'approved' : 'cancelled',
              approvedAt: decision === 'approve' ? new Date().toISOString() : item.approvedAt,
              updatedAt: new Date().toISOString(),
            }
          : item))
      }
    } catch (error) {
      console.error('[PlanPanel] 提交 plan approval 失败:', error)
    } finally {
      setApprovalBusy(false)
    }
  }

  // 自动滚动到当前执行步骤
  useEffect(() => {
    activeStepRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [steps])

  if (shouldShowPlanEmptyState(latestStructuredPlan, pendingPlanApproval)) {
    return (
      <div className="flex h-full flex-col bg-[var(--surface-2)]">
        <PlanPanelHeader />
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="space-y-2">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-3)]">
              <ClipboardList size={17} />
            </div>
            <p className="text-[13px] font-medium text-[var(--text-2)]">暂无计划</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--surface-2)]">
      <PlanPanelHeader />
      <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-3 py-3">
        <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_90%,transparent)] p-3 shadow-[0_18px_40px_-34px_hsl(var(--shadow-panel)/0.34)]">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]">
              <PlayCircle size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-[var(--text-1)]">
                {latestStructuredPlan?.goal || pendingPlanApproval?.title || '执行计划'}
              </div>
              {(latestStructuredPlan?.summary || pendingPlanApproval?.summary || pendingPlanApproval?.message) && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-3)]">
                  {latestStructuredPlan?.summary || pendingPlanApproval?.summary || pendingPlanApproval?.message}
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[10.5px] text-[var(--text-3)]">
            <span>{completedCount}/{steps.length} 已完成</span>
            <span>{failedCount > 0 ? `${failedCount} 个失败` : activeStep ? '正在执行' : statusLabel[steps[0]?.status ?? 'pending']}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]">
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,var(--brand),var(--brand-2))] transition-[width] duration-300"
              style={{ width: `${progressValue}%` }}
            />
          </div>
          {canContinuePlan && (
            <button
              type="button"
              disabled={continueBusy}
              onClick={() => void runPlanIntent('continue')}
              className="mt-3 h-8 w-full rounded-lg bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] px-2 text-[11px] font-medium text-[var(--brand)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_14%,var(--surface-1))] disabled:opacity-50"
            >
              {continueBusy ? '继续中...' : '继续执行'}
            </button>
          )}
          {(canRetryPlan || canSkipPlan) && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {canRetryPlan && (
                <button
                  type="button"
                  disabled={continueBusy}
                  onClick={() => void runPlanIntent('retry')}
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-amber-500/10 px-2 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/15 disabled:opacity-50"
                >
                  <RotateCcw size={12} />
                  重试
                </button>
              )}
              {canSkipPlan && (
                <button
                  type="button"
                  disabled={continueBusy}
                  onClick={() => void runPlanIntent('skip')}
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
      {pendingPlanApproval && (
        <div className="border-b border-[var(--border)] bg-amber-500/[0.055] px-3 py-3">
          <div className="rounded-xl border border-amber-500/20 bg-[color:color-mix(in_oklab,var(--surface-1)_86%,transparent)] p-3">
            <div className="text-[12.5px] font-semibold text-[var(--text-1)]">{pendingPlanApproval.title}</div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-3)]">
              {pendingPlanApproval.message}
            </p>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={approvalBusy}
              onClick={() => void resolveApproval('approve')}
              className="h-8 flex-1 rounded-lg bg-emerald-500/12 px-2 text-[11px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/18 disabled:opacity-50"
            >
              批准执行
            </button>
            <button
              type="button"
              disabled={approvalBusy}
              onClick={() => void resolveApproval('reject')}
              className="h-8 flex-1 rounded-lg bg-destructive/10 px-2 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 px-3 py-3">
          {steps.length === 0 && (
            <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] bg-[var(--surface-1)] px-3 py-3 text-[12px] leading-relaxed text-[var(--text-3)]">
              计划已生成，正在等待批准。当前计划未包含可展示步骤。
            </div>
          )}
          {steps.map((step, index) => (
            <div
              key={step.id}
              ref={step.status === 'running' ? activeStepRef : undefined}
              className={cn(
                'flex items-start gap-2.5 rounded-xl border bg-[var(--surface-1)] px-3 py-3 text-[12px] transition-colors',
                step.status === 'running'
                  ? 'border-[color:color-mix(in_oklab,var(--brand)_34%,var(--border-strong))] shadow-[0_18px_40px_-36px_color-mix(in_oklab,var(--brand)_60%,transparent)]'
                  : 'border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)]',
                step.status === 'failed' && 'border-destructive/24 bg-destructive/5'
              )}
            >
              <span className={cn(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-[10.5px] font-semibold',
                step.status === 'completed' && 'border-emerald-500/18 bg-emerald-500/8',
                step.status === 'running' && 'border-[color:color-mix(in_oklab,var(--brand)_24%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--surface-1))]',
                step.status === 'pending' && 'border-[var(--border)] bg-[var(--surface-2)]',
                step.status === 'failed' && 'border-destructive/20 bg-destructive/8',
              )}>
                {step.status === 'pending' ? index + 1 : statusIcon[step.status]}
              </span>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-start gap-2">
                  <span className={cn(
                    'block min-w-0 flex-1 leading-relaxed',
                    (step.status === 'completed' || step.status === 'skipped') ? 'text-[var(--text-3)] line-through' : 'text-[var(--text-1)]'
                  )}>
                    {formatStructuredStepText(step)}
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
                {step.status === 'failed' && step.error && (
                  <p className="break-words text-[11px] leading-relaxed text-destructive/80">
                    {step.error}
                  </p>
                )}
                {(step.attemptCount ?? 0) > 0 && step.status !== 'completed' && (
                  <p className="text-[10px] text-amber-600/70 dark:text-amber-400/70">
                    已尝试 {step.attemptCount} 次
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function PlanPanelHeader() {
  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
        <ClipboardList size={15} className="text-[var(--brand)]" />
        计划
      </div>
    </div>
  )
}

function formatStructuredStepText(step: AgentStructuredPlanStep): string {
  if (step.status === 'completed' && step.result?.trim()) {
    return `${step.title || step.description || step.id}\n${step.result}`
  }
  return step.title || step.description || step.id
}
